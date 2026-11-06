#!/bin/bash
EXP=/home/zacch/quchen-rocm-experiments/20261003-231142
SDK="$EXP/sdk"
systemd-run --user --unit=quchen-nightly-8082.service --property=Restart=on-failure \
    --setenv="HOME=/home/zacch" \
    --setenv="PYTHONPATH=/home/zacch/projects/quchen-amd/build-hip/hipify" \
    --setenv="ROCM_PATH=$SDK" --setenv="HIP_PATH=$SDK" \
    --setenv="HIP_DEVICE_LIB_PATH=$SDK/amdgcn/bitcode" \
    --setenv="LD_LIBRARY_PATH=$SDK/lib:$SDK/lib64" \
    --setenv="QUCHEN_SELECT_WMMA=1" --setenv="HIP_VISIBLE_DEVICES=0" \
    /usr/sbin/bash -c "exec /home/zacch/projects/quchen-amd/.venv-rocm/bin/python /home/zacch/projects/quchen-amd/build-hip/hipify/serve/server.py --engine quchen --config $EXP/serve-nightly-8082.json --port 8082 --host 127.0.0.1 >> $EXP/logs/server-nightly-8082.log 2>&1"
