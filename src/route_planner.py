"""Drone swarm coverage-route simulation used by the Avaris prototype.

Targets are clustered across a synthetic 2D disaster area, assigned to drones,
and routed with a nearest-neighbor heuristic plus local 2-opt refinement.
"""

import argparse
import os
import pickle
import hashlib
import tempfile
import numpy as np
import matplotlib.animation as animation
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider
from sklearn.cluster import MiniBatchKMeans
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures import ThreadPoolExecutor

# -----------------------------
# PARAMETERS & SETTINGS
# -----------------------------
WIDTH = 50             # Coverage area width
HEIGHT = 50           # Coverage area height
CELL_SIZE = 1         # Grid cell size (for generating targets)

NUM_DRONES = 5          # Guess...
DRONE_SPEED = 2       # Nominal drone speed (used in cost computation)
WIND_VECTOR = np.array([0.5, 0.0])   # Constant wind vector (e.g., blowing rightward)
MAX_TURN_ANGLE = np.pi / 4           # Maximum turning angle (radians) before penalty-- only relevant for fixed-wing drones. 
TURNING_WEIGHT = 1.0                 # Weight for turning penalty

SENSOR_RANGE = 5      # A target is considered "covered" if within this distance
START_POINT = np.array([WIDTH/2, HEIGHT/2])  # Start/end point for all drones

# Animation parameters
ANIMATION_VELOCITY = 2.0   # constant velocity (units/second) of drone markers
FPS = 30                   # frames per second (used for trajectory computation)

# -----------------------------
# DISK CACHE SETTINGS
# -----------------------------
CACHE_CAPACITY = 50  # maximum number of unique clusters to cache
CACHE_VERSION = b"2"  # bump when route semantics change
CACHE_DIR = os.path.join(tempfile.gettempdir(), "drone_path_cache")
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

def get_cache_path(key):
    """Return a full filename path for the given MD5 key (which represents a cluster)."""
    return os.path.join(CACHE_DIR, f"{key}.pkl")

def maintain_cache_capacity():
    """
    Maintain that there are at most CACHE_CAPACITY cached clusters.
    This function checks the files in CACHE_DIR and removes the oldest ones if more than CACHE_CAPACITY exist.
    """
    files = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR) if f.endswith(".pkl")]
    if len(files) <= CACHE_CAPACITY:
        return
    files.sort(key=lambda x: os.path.getmtime(x))  # oldest first
    while len(files) > CACHE_CAPACITY:
        oldest = files.pop(0)
        try:
            os.remove(oldest)
            print(f"Removed oldest cached cluster: {os.path.basename(oldest)}")
        except Exception as e:
            print(f"Error removing cached file {oldest}: {e}")

def compute_cluster_key(cluster):
    """
    Compute an MD5 hex digest key from the sorted cluster points.
    (This key uniquely identifies a cluster, so that routes are cached per cluster.)
    """
    order = np.lexsort((cluster[:, 1], cluster[:, 0]))
    sorted_cluster = cluster[order]
    route_config = np.concatenate((
        START_POINT.astype(np.float64),
        WIND_VECTOR.astype(np.float64),
        np.array([SENSOR_RANGE, DRONE_SPEED, MAX_TURN_ANGLE, TURNING_WEIGHT], dtype=np.float64),
    ))
    payload = CACHE_VERSION + sorted_cluster.tobytes() + route_config.tobytes()
    return hashlib.blake2b(payload, digest_size=16).hexdigest()

# -----------------------------
# COST CALCULATION FUNCTIONS
# -----------------------------
def segment_travel_time(p1, p2, drone_speed, wind_vector):
    """Estimate travel time for one segment, including a constant wind vector."""
    vec = p2 - p1
    distance = np.sqrt(np.sum((vec)**2))
    if distance < 1e-6:
        return 0.0
    direction = vec / distance
    wind_effect = np.dot(wind_vector, direction)
    effective_speed = drone_speed + wind_effect
    effective_speed = max(effective_speed, 0.1)
    return distance / effective_speed


def compute_turning_cost(path, max_turn_angle):
    """Penalize turns that exceed the configured maximum turn angle."""
    cost = 0.0
    for i in range(1, len(path)-1):  # Iteration
        v1 = path[i] - path[i-1]
        v2 = path[i+1] - path[i]
        norm_v1 = np.sqrt(np.sum(v1**2))
        norm_v2 = np.sqrt(np.sum(v2**2))
        if norm_v1 < 1e-6 or norm_v2 < 1e-6:
            continue
        cos_angle = np.dot(v1, v2)/(norm_v1*norm_v2)
        cos_angle = min(max(cos_angle, -1.0), 1.0)
        angle = np.arccos(cos_angle)
        if angle > max_turn_angle:
            cost += (angle - max_turn_angle)
    return cost

def compute_deviation(p_prev, p, p_next):
    """helper for smooth_route """
    line_vec = p_next - p_prev
    line_vec_norm = np.sqrt(np.sum(line_vec**2))
    if line_vec_norm < 1e-6:
        return np.sqrt(np.sum((p - p_prev)**2))
    t_param = np.dot(p - p_prev, line_vec) / np.dot(line_vec, line_vec)
    proj = p_prev + t_param * line_vec
    return np.sqrt(np.sum((p - proj)**2))

def smooth_route(route, tolerance=0.5):
    """Remove nearly collinear waypoints while preserving route shape."""
    if len(route) < 3:
        return route
    smoothed = [route[0]]
    route_array = np.array(route)  # Ensure a NumPy array
    
    for i in range(1, len(route)-1):
        deviation = compute_deviation(
            route_array[i-1], 
            route_array[i], 
            route_array[i+1]
        )
        if deviation > tolerance:
            smoothed.append(route[i])
    smoothed.append(route[-1])
    return np.array(smoothed)


def _compute_path_cost(path, drone_speed, wind_vector, max_turn_angle, turning_weight):
    """Combine wind-adjusted travel time with a turning penalty."""
    travel_time = 0.0
    for i in range(1, len(path)):
        travel_time += segment_travel_time(path[i-1], path[i], drone_speed, wind_vector)
    turning_cost = compute_turning_cost(path, max_turn_angle)
    return travel_time + turning_weight * turning_cost

# -----------------------------
# GRID TARGET GENERATION & CLUSTERING
# -----------------------------

def _generate_grid_targets(width, height, cell_size):
    """Generate evenly spaced target points across the simulated area."""
    num_rows = int(height / cell_size)
    num_cols = int(width / cell_size)
    targets = np.zeros((num_rows * num_cols, 2))
    
    for i in range(num_rows):
        for j in range(num_cols):
            idx = i * num_cols + j
            targets[idx, 0] = (j + 0.5) * cell_size
            targets[idx, 1] = (i + 0.5) * cell_size
    
    return targets

def generate_grid_targets(width, height, cell_size):
    return _generate_grid_targets(width, height, cell_size)


def split_clusters(targets, labels, num_clusters):
    """Split target coords into arrays using cluster labels."""
    clusters = []
    for i in range(num_clusters):
        mask = (labels == i)
        cluster_points = targets[mask]
        clusters.append(cluster_points)
    return clusters

def cluster_targets(targets, num_clusters):
    """Partition coverage targets among drones with MiniBatchKMeans."""
    kmeans = MiniBatchKMeans(
        n_clusters=num_clusters,
        batch_size=1000,
        max_iter=100,
        random_state=0
    )
    labels = kmeans.fit_predict(targets)
    return split_clusters(targets, labels, num_clusters)

# -----------------------------
# ROUTE SOLVER FUNCTIONS
# -----------------------------

def _covering_nearest_neighbor(targets, start, sensor_radius, chunk_size=100):
    """Build a coverage route while marking nearby targets as visited."""
    n_targets = len(targets)
    visited_mask = np.zeros(n_targets, dtype=np.bool_)
    route = np.zeros((n_targets + 1, 2))
    route[0] = start
    route_idx = 1
    current = start
    
    while not np.all(visited_mask):
        # Process targets in chunks for better cache utilization
        chunks = (n_targets + chunk_size - 1) // chunk_size
        min_dist = np.inf
        nearest_idx = -1
        
        for chunk in range(chunks):
            start_idx = chunk * chunk_size
            end_idx = min(start_idx + chunk_size, n_targets)
            chunk_targets = targets[start_idx:end_idx]
            chunk_mask = visited_mask[start_idx:end_idx]
            
            # Compute distances for unvisited targets in chunk
            if not np.all(chunk_mask):
                chunk_distances = np.sqrt(np.sum((chunk_targets - current)**2, axis=1))
                masked_distances = np.where(chunk_mask, np.inf, chunk_distances)
                chunk_min_idx = np.argmin(masked_distances)
                if chunk_distances[chunk_min_idx] < min_dist and not chunk_mask[chunk_min_idx]:
                    min_dist = chunk_distances[chunk_min_idx]
                    nearest_idx = start_idx + chunk_min_idx
        
        if nearest_idx >= 0:
            current = targets[nearest_idx]
            route[route_idx] = current
            route_idx += 1
            
            # Vectorized neighbor marking
            distances = np.sqrt(np.sum((targets - current)**2, axis=1))
            visited_mask |= (distances <= sensor_radius)
    
    return route[:route_idx]

def covering_nearest_neighbor(targets, start, sensor_radius):
    """Normalize input arrays before running the routing helper."""
    targets = np.array(targets, dtype=np.float64)
    start = np.array(start, dtype=np.float64)
    return _covering_nearest_neighbor(targets, start, sensor_radius)

def _two_opt(route, max_iterations=30, improvement_threshold=0.01):
    """Apply a bounded local 2-opt search while preserving route endpoints."""
    n = len(route)
    best_distance = _compute_path_cost(route, DRONE_SPEED, WIND_VECTOR, MAX_TURN_ANGLE, TURNING_WEIGHT)
    
    # Pre-compute segment lengths
    segment_lengths = np.zeros(n-1)
    for i in range(n-1):
        segment_lengths[i] = np.sqrt(np.sum((route[i+1] - route[i])**2))
    
    if n < 4:
        return route

    for iteration in range(max_iterations):
        improved = False

        # Focus on longer interior segments while keeping the base point fixed
        # at both ends of the closed route.
        long_segments = np.where(segment_lengths > np.mean(segment_lengths))[0]
        valid_starts = long_segments[(long_segments >= 1) & (long_segments <= n - 3)]
        if len(valid_starts) > 0:
            for _ in range(min(n, 15)):
                i = valid_starts[np.random.randint(0, len(valid_starts))]
                j_low = i + 2
                j_high = min(i + 20, n - 1)  # exclusive; preserves route[-1]
                if j_low >= j_high:
                    continue
                j = np.random.randint(j_low, j_high)

                # Efficient in-place reversal
                route[i:j+1] = route[i:j+1][::-1]
                new_distance = _compute_path_cost(route, DRONE_SPEED, WIND_VECTOR, MAX_TURN_ANGLE, TURNING_WEIGHT)
                
                if new_distance < best_distance - improvement_threshold:
                    best_distance = new_distance
                    improved = True
                    # Update segment lengths
                    for k in range(i-1, j+1):
                        if k >= 0 and k < n-1:
                            segment_lengths[k] = np.sqrt(np.sum((route[k+1] - route[k])**2))
                    break
                else:
                    route[i:j+1] = route[i:j+1][::-1]
        
        if not improved:
            break
            
    return route

def two_opt(route):
    """Normalize input arrays before running the routing helper."""
    route = np.array(route, dtype=np.float64)
    return _two_opt(route)

def solve_drone_route(drone_index, cluster):
    """Solve and cache one drone route for an assigned target cluster."""
    key = compute_cluster_key(cluster)
    cache_path = get_cache_path(key)
    
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "rb") as f:
                route = pickle.load(f)
            print(f"Drone {drone_index+1}: Using cached route for cluster {key}.")
            return drone_index, route
        except Exception as e:
            print(f"Error loading cache for Drone {drone_index+1}: {e}")
    
    print(f"Solving route for Drone {drone_index+1} with {len(cluster)} targets...")
    
    init_route = covering_nearest_neighbor(cluster, START_POINT, SENSOR_RANGE)
    
    if not np.allclose(init_route[0], init_route[-1]):
        closed_route = np.vstack((init_route, init_route[0]))
    else:
        closed_route = init_route
        
    # Keep the historical randomized 2-opt search reproducible per drone.
    np.random.seed(drone_index)
    optimized_route = two_opt(closed_route)
    optimized_route = smooth_route(optimized_route, tolerance=0.5)
    
    try:
        with open(cache_path, "wb") as f:
            pickle.dump(optimized_route, f)
        maintain_cache_capacity()
    except Exception as e:
        print(f"Error saving cache for Drone {drone_index+1}: {e}")
    
    return drone_index, optimized_route

# -----------------------------
# ANIMATION FUNCTION W/ CUSTOM FRAME GENERATOR & SPEED SLIDER
# -----------------------------
def _resample_trajectory(trajectory, frame_count):
    """Resample a trajectory to a fixed frame count for responsive playback."""
    if len(trajectory) <= 1 or frame_count <= 1:
        return trajectory
    source = np.linspace(0.0, 1.0, len(trajectory))
    target = np.linspace(0.0, 1.0, frame_count)
    x = np.interp(target, source, trajectory[:, 0])
    y = np.interp(target, source, trajectory[:, 1])
    return np.column_stack((x, y))


def animate_drones(
    drone_trajectories,
    route_lines,
    refresh_interval=50,
    save_path=None,
    show=True,
    max_frames=600,
):
    """Display (and optionally save) a reliable multi-drone route animation."""
    frame_count = min(max(len(traj) for traj in drone_trajectories), max_frames)
    display_trajectories = [
        _resample_trajectory(np.asarray(traj), frame_count)
        for traj in drone_trajectories
    ]

    fig, ax = plt.subplots(figsize=(8.5, 8.5))
    if show:
        plt.subplots_adjust(bottom=0.20)
    ax.set_xlim(0, WIDTH)
    ax.set_ylim(0, HEIGHT)
    ax.set_aspect("equal", adjustable="box")
    ax.set_xlabel("X")
    ax.set_ylabel("Y")
    ax.set_title("Avaris Multi-Drone Coverage Simulation")
    ax.grid(True, alpha=0.25)

    targets = generate_grid_targets(WIDTH, HEIGHT, CELL_SIZE)
    ax.scatter(targets[:, 0], targets[:, 1], c="lightgray", marker="s", s=5, label="Coverage targets")

    colors = ["tab:blue", "tab:orange", "tab:green", "tab:red", "tab:purple"]
    for i, route in enumerate(route_lines):
        route = np.asarray(route, dtype=np.float64)
        ax.plot(route[:, 0], route[:, 1], "--", color=colors[i % len(colors)], alpha=0.45, linewidth=1.2)
    ax.plot(START_POINT[0], START_POINT[1], "kx", markersize=12, markeredgewidth=2, label="Launch / recovery")

    wind_scale = 5
    ax.arrow(5, HEIGHT - 5, WIND_VECTOR[0] * wind_scale, WIND_VECTOR[1] * wind_scale,
             head_width=1.5, head_length=1.8, fc="k", ec="k", length_includes_head=True)
    ax.text(5, HEIGHT - 9, "Wind", fontsize=9)

    drone_markers = []
    for i in range(len(display_trajectories)):
        marker, = ax.plot([], [], "o", color=colors[i % len(colors)], markersize=8, label=f"Drone {i + 1}")
        drone_markers.append(marker)

    def init():
        for marker in drone_markers:
            marker.set_data([], [])
        return drone_markers

    def update(frame):
        for i, trajectory in enumerate(display_trajectories):
            position = trajectory[min(frame, len(trajectory) - 1)]
            drone_markers[i].set_data([position[0]], [position[1]])
        return drone_markers

    anim = animation.FuncAnimation(
        fig,
        update,
        frames=range(frame_count),
        init_func=init,
        interval=refresh_interval,
        blit=True,
        repeat=False,
    )

    if show:
        slider_ax = fig.add_axes([0.25, 0.08, 0.50, 0.025])
        speed_slider = Slider(slider_ax, "Playback speed", 0.25, 4.0, valinit=1.0, valstep=0.25)

        def update_speed(_value):
            anim.event_source.interval = refresh_interval / speed_slider.val

        speed_slider.on_changed(update_speed)
        # Keep a reference alive for the lifetime of the figure.
        fig._avaris_speed_slider = speed_slider

    ax.legend(loc="upper right", fontsize=8)

    if save_path:
        from matplotlib.animation import PillowWriter
        print(f"Saving animation to {save_path}...")
        anim.save(save_path, writer=PillowWriter(fps=max(1, round(1000 / refresh_interval))))
        print(f"Saved {save_path}")

    if show:
        plt.show()
    else:
        plt.close(fig)

    return anim

# -----------------------------
# MAIN EXECUTION
# -----------------------------
def process_route_batch(batch):
    """Process a batch of routes in parallel"""
    return [solve_drone_route(drone_index, cluster) for drone_index, cluster in batch]

def main(save_path=None, show=True):
    print("Generating targets...")
    targets = generate_grid_targets(WIDTH, HEIGHT, CELL_SIZE)
    
    print("Clustering targets...")
    clusters = cluster_targets(targets, NUM_DRONES)
    
    print("Processing routes...")
    results = {}
    uncached_tasks = []
    
    # Process cached routes
    for i, cluster in enumerate(clusters):
        key = compute_cluster_key(cluster)
        cache_path = get_cache_path(key)
        
        if os.path.exists(cache_path):
            try:
                with open(cache_path, 'rb') as f:
                    route = pickle.load(f)
                    results[i] = route
                    print(f"Using cached route for drone {i+1}")
            except Exception as e:
                uncached_tasks.append((i, cluster))
        else:
            uncached_tasks.append((i, cluster))
    
    # Process uncached routes in batches
    if uncached_tasks:
        batch_size = max(1, len(uncached_tasks) // (os.cpu_count() or 1))
        batches = [uncached_tasks[i:i + batch_size] for i in range(0, len(uncached_tasks), batch_size)]
        
        with ProcessPoolExecutor(max_workers=min(len(batches), os.cpu_count() or 1)) as executor:
            futures = [executor.submit(process_route_batch, batch) for batch in batches]
            for future in as_completed(futures):
                for drone_index, route in future.result():
                    results[drone_index] = route
    
    # Compute trajectories in parallel
    print("Computing trajectories...")
    routes = [results[i] for i in range(NUM_DRONES)]
    batch_size = max(1, NUM_DRONES // (os.cpu_count() or 1))
    route_batches = [routes[i:i + batch_size] for i in range(0, NUM_DRONES, batch_size)]
    
    trajectory_batches = [None] * len(route_batches)
    with ThreadPoolExecutor(max_workers=min(len(route_batches), os.cpu_count() or 1)) as executor:
        future_to_index = {
            executor.submit(
                compute_trajectory_batch,
                batch,
                ANIMATION_VELOCITY,
                FPS,
            ): index
            for index, batch in enumerate(route_batches)
        }
        for future in as_completed(future_to_index):
            trajectory_batches[future_to_index[future]] = future.result()

    trajectories = [
        trajectory
        for batch in trajectory_batches
        for trajectory in batch
    ]
    
    if not trajectories:
        print("Error: No trajectories generated!")
        return
    
    print("Starting animation...")
    animate_drones(
        trajectories,
        routes,
        refresh_interval=50,
        save_path=save_path,
        show=show,
        max_frames=240 if save_path else 600,
    )

def compute_trajectory_batch(routes, constant_velocity, fps):
    """Compute trajectories for multiple routes in parallel"""
    trajectories = []
    
    for route in routes:
        traj = []
        for i in range(len(route)-1):
            p0 = route[i]
            p1 = route[i+1]
            distance = np.sqrt(np.sum((p1 - p0)**2))
            n_frames = max(1, int(np.ceil(distance * fps / constant_velocity)))
            
            for t in np.linspace(0, 1, n_frames, endpoint=False):
                traj.append((1-t)*p0 + t*p1)
        traj.append(route[-1])
        trajectories.append(np.array(traj))
    
    return trajectories

def parse_args():
    parser = argparse.ArgumentParser(description="Run the Avaris multi-drone coverage simulation.")
    parser.add_argument("--save", metavar="PATH", help="Save the animation as a GIF (for example, route_demo.gif).")
    parser.add_argument("--no-show", action="store_true", help="Do not open the interactive Matplotlib window.")
    return parser.parse_args()


if __name__ == '__main__':
    args = parse_args()
    main(save_path=args.save, show=not args.no_show)
