// metal/src/engine/stubs_gyro.cpp - the Gyro (agentionai trellis experts) entry points the Metal engine does not implement:
// the GPU Hadamard rotations of src/kernels/cuda/iq_kernels.cu.  native_expert_supported() (iq_host.cpp) does not list the
// trellis types, so a Gyro pack stops at load with its reason and these are never reached with a supported file.
// Each stops the engine with its name, like stubs.cpp.

#include <cstdint>

#include "quchen/kernels/iq_kernels.hpp"

namespace quchen::metal_engine {
void missing(const char* name);
}

namespace quchen::kernels {
void hadamard_rows(const float*, float*, int64_t, int64_t, int, const float*, void*) {
    quchen::metal_engine::missing("quchen::kernels::hadamard_rows");
}
void hadamard_rows_f16(uint16_t*, int64_t, int64_t, int, const float*, void*) {
    quchen::metal_engine::missing("quchen::kernels::hadamard_rows_f16");
}
const float* hadamard_device_signs(const float*, int) {
    quchen::metal_engine::missing("quchen::kernels::hadamard_device_signs");
    return nullptr;
}
}  // namespace quchen::kernels
