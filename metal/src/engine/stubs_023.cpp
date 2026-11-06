// metal/src/engine/stubs_023.cpp - the two research hooks of the shared Verifier::record_window that only the CUDA / HIP backends implement
// (src/kernels/cuda/verify_kernels.cu): hc_mean_streams (QUCHEN_TAP_FILE) and route_marginal_stats (QUCHEN_ROUTE_STATS).  Verifier::record_window
// does not run on Metal (init hands over to the Metal window, metal/src/engine/window.cpp), so neither is reached; if one ever is, it stops
// the engine with its name instead of continuing on outputs nobody wrote.  They exist so the shared host file links.

#include <cstdint>

#include "quchen/kernels/verify_kernels.hpp"

namespace quchen::metal_engine { void missing(const char* name); }

namespace quchen::kernels {
void hc_mean_streams(const float*, float*, int64_t, int, void*) { quchen::metal_engine::missing("quchen::kernels::hc_mean_streams"); }
void route_marginal_stats(const int32_t*, int, int, unsigned long long*, void*) { quchen::metal_engine::missing("quchen::kernels::route_marginal_stats"); }
}  // namespace quchen::kernels
