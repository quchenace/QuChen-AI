// metal/src/engine/stubs_0145.cpp - the kernel-library entry points the 0.1.45 sources added and Metal does not implement yet.
// Same job and shape as stubs.cpp (each stops the engine with its name, metal/src/engine/missing.cpp). Written from the linker's
// undefined-symbol report because tools/gen_stubs.py reads an older clang AST dump format than macOS 27's clang prints.
// A symbol that gets a Metal implementation is deleted from here. fused_gr_persist_init / fused_gr_read_persist / f16_range_read /
// gemm_f16_range_read are opt-in features of the HIP and Turing builds: off on Metal, so they answer "nothing to do" instead of stopping the engine.

#include "quchen/kernels/bf16_bits.hpp"
#include "quchen/kernels/bf16_gemv.hpp"
#include "quchen/kernels/cvec.hpp"
#include "quchen/kernels/dequant_bf16.hpp"
#include "quchen/kernels/dequant_s2.hpp"
#include "quchen/kernels/elementwise.hpp"
#include "quchen/kernels/f16_bits.hpp"
#include "quchen/kernels/fused_gdn.hpp"
#include "quchen/kernels/fused_gr.hpp"
#include "quchen/kernels/gdn.hpp"
#include "quchen/kernels/gfx_arch.hpp"
#include "quchen/kernels/gr.hpp"
#include "quchen/kernels/iq_kernels.hpp"
#include "quchen/kernels/kv_q4.hpp"
#include "quchen/kernels/kv_q8.hpp"
#include "quchen/kernels/kv_stream.hpp"
#include "quchen/kernels/mrope.hpp"
#include "quchen/kernels/native_flash_attn.hpp"
#include "quchen/kernels/native_gdn.hpp"
#include "quchen/kernels/native_gdn_preprocess.hpp"
#include "quchen/kernels/native_gr_norm.hpp"
#include "quchen/kernels/native_gr_postops.hpp"
#include "quchen/kernels/native_mmvq.hpp"
#include "quchen/kernels/native_moe.hpp"
#include "quchen/kernels/native_ple_postops.hpp"
#include "quchen/kernels/native_qsa.hpp"
#include "quchen/kernels/native_qsa_indexer.hpp"
#include "quchen/kernels/native_qsa_score.hpp"
#include "quchen/kernels/native_rope.hpp"
#include "quchen/kernels/native_router.hpp"
#include "quchen/kernels/ngram.hpp"
#include "quchen/kernels/pdl.hpp"
#include "quchen/kernels/ple.hpp"
#include "quchen/kernels/qsa.hpp"
#include "quchen/kernels/qsa_decode_attn.hpp"
#include "quchen/kernels/qsa_prompt_attn.hpp"
#include "quchen/kernels/qsa_select.hpp"
#include "quchen/kernels/quantize_act.hpp"
#include "quchen/kernels/rope.hpp"
#include "quchen/kernels/rope_scaling.hpp"
#include "quchen/kernels/route_prior.hpp"
#include "quchen/kernels/router_top10.hpp"
#include "quchen/kernels/s2_expert_grouped.hpp"
#include "quchen/kernels/s2_gemv.hpp"
#include "quchen/kernels/s2_gemv_q8.hpp"
#include "quchen/kernels/s_gemv.hpp"
#include "quchen/kernels/sampler.hpp"
#include "quchen/kernels/shared_expert.hpp"
#include "quchen/kernels/verify_kernels.hpp"
#include "quchen/kernels/cpu/expert.hpp"
#include "quchen/kernels/cpu/expert_layout.hpp"
#include "quchen/kernels/cpu/iq_avx1.hpp"
#include "quchen/kernels/cpu/iq_avx2.hpp"
#include "quchen/kernels/cpu/iq_avx512.hpp"
#include "quchen/kernels/cpu/kq_avx1.hpp"
#include "quchen/kernels/cpu/kq_avx2.hpp"
#include "quchen/kernels/cpu/native_expert.hpp"
#include "quchen/kernels/cpu/pool.hpp"
#include "quchen/prefill/gemm.hpp"
#include "quchen/prefill/kernels.hpp"
#include "quchen/prefill/moe_fused.hpp"
#include "quchen/prefill/moe_fused_iq.hpp"
#include "quchen/prefill/moe_mmq.hpp"
#include "quchen/prefill/prefill.hpp"
#include "quchen/prefill/share_rules.hpp"
#include "quchen/prefill/xmx_moe.hpp"
#include "quchen/core/arch_defaults.hpp"
#include "quchen/core/batch_rows.hpp"
#include "quchen/core/conversation_buffer.hpp"
#include "quchen/core/conversation_cache.hpp"
#include "quchen/core/conversation_file.hpp"
#include "quchen/core/conversation_memory.hpp"
#include "quchen/core/conversation_snapshot.hpp"
#include "quchen/core/coupled_draft.hpp"
#include "quchen/core/device.hpp"
#include "quchen/core/dma_batch.hpp"
#include "quchen/core/emulate.hpp"
#include "quchen/core/exchange_storage.hpp"
#include "quchen/core/expert_cache.hpp"
#include "quchen/core/expert_source.hpp"
#include "quchen/core/foresight_swap.hpp"
#include "quchen/core/graph.hpp"
#include "quchen/core/hit_hook.hpp"
#include "quchen/core/layer.hpp"
#include "quchen/core/layout.hpp"
#include "quchen/core/logit_bias.hpp"
#include "quchen/core/mtp.hpp"
#include "quchen/core/native_dense.hpp"
#include "quchen/core/native_head.hpp"
#include "quchen/core/on_device.hpp"
#include "quchen/core/peer_experts.hpp"
#include "quchen/core/pinned.hpp"
#include "quchen/core/pinned_ring.hpp"
#include "quchen/core/progress.hpp"
#include "quchen/core/remote_expert_opt.hpp"
#include "quchen/core/remote_experts.hpp"
#include "quchen/core/session.hpp"
#include "quchen/core/session_save_reclaim.hpp"
#include "quchen/core/spec_prob.hpp"
#include "quchen/core/verify.hpp"
#include "quchen/core/vmm.hpp"
#include "quchen/core/weights.hpp"
#include "quchen/platform/aux_cpus.hpp"
#include "quchen/platform/direct_file.hpp"
#include "quchen/platform/host_limits.hpp"
#include "quchen/platform/memory.hpp"
#include "quchen/ngram/ple_reader.hpp"
#include "quchen/spec/controller.hpp"
#include "quchen/spec/draft_policy.hpp"
#include "quchen/spec/draft_source.hpp"
#include "quchen/spec/suffix_drafter.hpp"
#include <type_traits>

#include <type_traits>

namespace quchen::metal_engine { void missing(const char* name); }

namespace quchen::kernels { void copy_rows_from_mapped_after(unsigned int const* p0, unsigned int p1, float* p2, float const* p3, long long p4, long long p5, int const* p6, int const* p7, void* p8) { quchen::metal_engine::missing("quchen::kernels::copy_rows_from_mapped_after"); } }
namespace quchen::kernels::cpu { void iq256_gu_rows_exact_one(int p0, unsigned char const* p1, unsigned long p2, unsigned long p3, int p4, void const* p5, float* p6, int p7, int p8) { quchen::metal_engine::missing("quchen::kernels::cpu::iq256_gu_rows_exact_one"); } }
namespace quchen::kernels { void fused_gr_persist_init() {  } }
namespace quchen::kernels { bool fused_gr_read_persist(quchen::kernels::FusedGrArgs const* p0, int p1, void* p2) {  return false; } }
namespace quchen::kernels { void gdn_step_norm_groups(quchen::kernels::GdnGroups const& p0, float const* p1, int p2, float const* p3, float const* p4, float const* p5, float const* p6, float p7, float* p8, int p9, int p10, bool p11, void* p12) { quchen::metal_engine::missing("quchen::kernels::gdn_step_norm_groups"); } }
namespace quchen::kernels { void handoff_publish(float* p0, float const* p1, long long p2, float const* p3, long long p4, float const* p5, long long p6, unsigned int* p7, unsigned int* p8, void* p9, unsigned int const* p10) { quchen::metal_engine::missing("quchen::kernels::handoff_publish"); } }
namespace quchen::kernels { void hc_q8_to_bf16(void const* p0, float const* p1, unsigned short* p2, long long p3, void* p4) { quchen::metal_engine::missing("quchen::kernels::hc_q8_to_bf16"); } }
namespace quchen::kernels { void native_quantize_q8_1_il(float const* p0, void* p1, void* p2, int p3, int p4, void* p5) { quchen::metal_engine::missing("quchen::kernels::native_quantize_q8_1_il"); } }
namespace quchen::kernels { void qsa_block_scores_rows(quchen::kernels::QsaScoreRows const& p0, float const* p1, int const* p2, long long p3, long long p4, quchen::kernels::QsaShapes const& p5, float* p6, void* p7) { quchen::metal_engine::missing("quchen::kernels::qsa_block_scores_rows"); } }
namespace quchen::kernels { void qsa_decode_attn_batch_rows(float const* p0, quchen::kernels::QsaAttnPoolsRows const& p1, int const* p2, int const* p3, long long p4, quchen::kernels::QsaShapes const& p5, float* p6, float* p7, long long p8, void* p9) { quchen::metal_engine::missing("quchen::kernels::qsa_decode_attn_batch_rows"); } }
namespace quchen::kernels { bool qsa_decode_attn_split(float const* p0, quchen::kernels::QsaAttnPools const& p1, int const* p2, int const* p3, long long p4, quchen::kernels::QsaShapes const& p5, float* p6, unsigned long long p7, float* p8, long long p9, void* p10) { quchen::metal_engine::missing("quchen::kernels::qsa_decode_attn_split"); return {}; } }
namespace quchen::kernels { void res_patch(int* p0, int const* p1, int p2, void* p3) { quchen::metal_engine::missing("quchen::kernels::res_patch"); } }
namespace quchen::kernels { void wait_copy_i32_from_mapped(unsigned int const* p0, unsigned int p1, int* p2, int const* p3, long long p4, void* p5) { quchen::metal_engine::missing("quchen::kernels::wait_copy_i32_from_mapped"); } }
namespace quchen::kernels { void wait_flag_ge_stamped(unsigned int const* p0, unsigned int p1, unsigned long long* p2, unsigned long long* p3, void* p4) { quchen::metal_engine::missing("quchen::kernels::wait_flag_ge_stamped"); } }
namespace quchen::kernels { void wait_handoff(unsigned int const* p0, unsigned int p1, unsigned int* p2, unsigned long long p3, void* p4) { quchen::metal_engine::missing("quchen::kernels::wait_handoff"); } }
namespace quchen::prefill { void moe_scatter_add(float const* p0, int const* p1, int const* p2, int const* p3, float const* p4, long long p5, float* p6, void* p7) { quchen::metal_engine::missing("quchen::prefill::moe_scatter_add"); } }
namespace quchen::prefill { void moe_shared_init(float const* p0, float const* p1, float* p2, long long p3, void* p4) { quchen::metal_engine::missing("quchen::prefill::moe_shared_init"); } }
namespace quchen::prefill { bool f16_range_read(float& p0, unsigned long long& p1, bool p2) {  return false; } }
namespace quchen::prefill { bool gemm_f16_range_read(float* p0, unsigned long long* p1, bool p2) {  return false; } }
namespace quchen::prefill { void gr_norm(float const* p0, float const* p1, float p2, float* p3, unsigned short* p4, long long p5, void* p6, unsigned short* p7, bool p8) { quchen::metal_engine::missing("quchen::prefill::gr_norm"); } }
namespace quchen::prefill { void gr_norm_rs(float const* p0, float const* p1, float p2, float* p3, unsigned short* p4, long long p5, void* p6, unsigned short* p7, long long p8, bool p9) { quchen::metal_engine::missing("quchen::prefill::gr_norm_rs"); } }
namespace quchen::prefill { void gr_write_cvec_norm_rs(float* p0, float const* p1, float const* p2, long long p3, float const* p4, float const* p5, int const* p6, int p7, float const* p8, float p9, float* p10, unsigned short* p11, long long p12, void* p13, unsigned short* p14, long long p15, bool p16) { quchen::metal_engine::missing("quchen::prefill::gr_write_cvec_norm_rs"); } }
namespace quchen::prefill { void gr_write_norm_rs(float* p0, float const* p1, float const* p2, long long p3, float const* p4, float p5, float* p6, unsigned short* p7, long long p8, void* p9, unsigned short* p10, long long p11, bool p12) { quchen::metal_engine::missing("quchen::prefill::gr_write_norm_rs"); } }
// pf_wmma (QUCHEN_PF_WMMA=1, Volta prompt experts) is CUDA only; the prefill code of 148/149 references it, so the Metal link needs the entry point. Off on Metal: "not launched".
namespace quchen::kernels { bool gemm_iq_f16_grouped(int p0, void const* p1, unsigned long p2, int p3, int p4, void const* p5, int p6, int const* p7, int p8, int p9, float* p10, int p11, void* p12) { return false; } }
// QUCHEN_Q8_SM60 (Pascal GP100, opt-in): a no-op on Metal; NativeHead::load()/unload() call these for a Q8_0 head, so they must exist and answer "nothing packed".
namespace quchen::kernels { bool native_q8_0_sm60_pack(void const* p0, int p1, int p2, char const* p3) { return false; } }
namespace quchen::kernels { void native_q8_0_sm60_release(void const* p0) { } }
// the MTP drafter's QUCHEN_MTP_Q8_SM60 packing (mtp.cpp): nothing packed on Metal
namespace quchen::kernels { bool native_q8_0_sm60_pack_quiet(void const* p0, int p1, int p2, char const* p3) { return false; } }
namespace quchen::kernels { bool native_q8_0_sm60_pack_in_place(void* p0, int p1, int p2, char const* p3) { return false; } }
// QUCHEN_SELECT_LONG (verify.cpp's long-context decode select): CUDA only; never reached on Metal (no scratch asked for)
namespace quchen::kernels { long long qsa_topk_multi_scratch_ints(long long p0) { return 0; } }
namespace quchen::kernels { void qsa_block_topk_long(float const* p0, int const* p1, long long p2, long long p3, long long p4, quchen::kernels::QsaShapes const& p5, int* p6, void* p7, long long p8, int* p9) { quchen::metal_engine::missing("quchen::kernels::qsa_block_topk_long"); } }
namespace quchen::kernels { void qsa_block_scores_long(float const* p0, float const* p1, float const* p2, int const* p3, long long p4, long long p5, quchen::kernels::QsaShapes const& p6, float* p7, void* p8, long long p9) { quchen::metal_engine::missing("quchen::kernels::qsa_block_scores_long"); } }
// only reached with pf_wmma (off on Metal)
namespace quchen::prefill { void swiglu_split_f16(float const* p0, unsigned short* p1, long long p2, int p3, bool p4, void* p5) { } }
// QUCHEN_PLE_COMPACT (opt-in, CUDA / HIP prompt path): prefill.cpp references it; the Metal prompt runs through its window and never reaches it.
namespace quchen::kernels { void ple_iq4nl_dequant(const uint8_t* p0, int64_t p1, float* p2, void* p3) { quchen::metal_engine::missing("quchen::kernels::ple_iq4nl_dequant"); } }
// QUCHEN_DEQUANT_SIDE (opt-in, CUDA only): off on Metal; the prompt path takes no second scratch and set_dequant_side(nullptr) keeps the serial form.
namespace quchen::prefill { bool gemm_dequant_side() { return false; } }
auto quchen::prefill::Gemm::set_dequant_side(uint16_t* p0, std::string& p1) -> bool { if (p0 == nullptr) return true; quchen::metal_engine::missing("quchen::prefill::Gemm::set_dequant_side"); return false; }
