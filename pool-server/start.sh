#!/bin/bash
set -euo pipefail

export POOL_HOST=0.0.0.0
export POOL_PORT=3333
export API_HOST=0.0.0.0
export API_PORT=8080
export RPC_URL=https://127.0.0.1:44107
export RPC_USER=pearlpool
export RPC_PASS=${RPC_PASS:-PrL_P00l_2026_Secur3}
export RPC_CERT=~/.pearld/rpc.cert
export POOL_WALLET=prl1paf83uwplzy4r3s4ukkud649009fwzgunmgh7phv8hdhu2jg2pnasua4t5k
export STRATUM_EASY=3333
export STRATUM_MEDIUM=4444
export STRATUM_HARD=5555
export DIFF_EASY=32
export DIFF_MEDIUM=128
export DIFF_HARD=512

cd ~/prl-pool
exec node src/pool.js
