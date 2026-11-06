# tools/vision - quchen-vision, the image encoder for QuChen's multimodal path (optional; setup.py builds it when
# the vision encoder is chosen).  Uses llama.cpp's mtmd library at the same pinned commit as the engine's ggml.
#
#   cmake -S tools/vision -B build-vision -G Ninja -DCMAKE_BUILD_TYPE=Release -DLLAMA_DIR=third_party/llama.cpp
#         [-DQUCHEN_VISION_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=native] [-DQUCHEN_PORTABLE=OFF]
#         [-DQUCHEN_VISION_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx (oneAPI sourced; Linux)]
#         [-DQUCHEN_VISION_HIP=ON -DQUCHEN_VISION_HIP_ARCHS="gfx1200;gfx1201" + the HIP compiler the engine build uses]
#   cmake --build build-vision --target quchen-vision
#
# Portable (AVX2 baseline) is the default, so an encoder built without extra flags runs on any AVX2 PC: the 0.1.32
# release's encoder was built native on an AVX-512 machine and stopped with an illegal instruction elsewhere
# (#411 #412 #419).  setup.py, which builds for the PC it runs on, passes -DQUCHEN_PORTABLE=OFF.  The option is
# kept in CMakeCache.txt, so a build folder configured before this default still needs the flag (or a fresh folder).
cmake_minimum_required(VERSION 3.21)
project(quchen_vision C CXX)

set(LLAMA_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/llama.cpp" CACHE PATH "llama.cpp checkout")
option(QUCHEN_VISION_CUDA "run the vision encoder on the GPU (builds ggml-cuda)" OFF)
option(QUCHEN_VISION_HIP "run the vision encoder on an AMD GPU (builds ggml-hip); the program is named quchen-vision-hip" OFF)
option(QUCHEN_VISION_SYCL "run the vision encoder on an Intel GPU (builds ggml-sycl, needs the oneAPI icx/icpx compilers); the program is named quchen-vision-sycl" OFF)
set(QUCHEN_VISION_HIP_ARCHS "" CACHE STRING "the gfx architectures quchen-vision-hip is compiled for (';'-separated)")
if(QUCHEN_VISION_HIP AND QUCHEN_VISION_CUDA)
  message(FATAL_ERROR "quchen-vision: QUCHEN_VISION_CUDA and QUCHEN_VISION_HIP are two different programs")
endif()
if(QUCHEN_VISION_SYCL AND (QUCHEN_VISION_CUDA OR QUCHEN_VISION_HIP))
  message(FATAL_ERROR "quchen-vision: QUCHEN_VISION_SYCL is its own program: not together with CUDA or HIP")
endif()
if(QUCHEN_VISION_HIP AND NOT QUCHEN_VISION_HIP_ARCHS)
  message(FATAL_ERROR "quchen-vision: QUCHEN_VISION_HIP needs QUCHEN_VISION_HIP_ARCHS, for example \"gfx1200;gfx1201\"")
endif()
option(QUCHEN_VISION_METAL "a Mac: ggml's Metal backend in the program, so --gpu reads pictures on the Mac's GPU (OFF: CPU only)" ON)
option(QUCHEN_PORTABLE "build for other PCs: AVX2 baseline, static MSVC runtime" ON)
if(QUCHEN_PORTABLE AND MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_MTMD ON CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
if(QUCHEN_PORTABLE)
  set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
  set(GGML_OPENMP OFF CACHE BOOL "" FORCE)        # no vcomp140.dll / libgomp needed on the user's PC
  foreach(_f GGML_AVX GGML_AVX2 GGML_FMA GGML_F16C GGML_BMI2)
    set(${_f} ON CACHE BOOL "" FORCE)
  endforeach()
  # nothing above AVX2 either, even when a -D asks for it (a 9900K or a Zen 3 has neither AVX-512 nor AVX-VNNI)
  foreach(_f GGML_AVX512 GGML_AVX512_VBMI GGML_AVX512_VNNI GGML_AVX512_BF16 GGML_AVX_VNNI
             GGML_AMX_TILE GGML_AMX_INT8 GGML_AMX_BF16)
    set(${_f} OFF CACHE BOOL "" FORCE)
  endforeach()
  message(STATUS "quchen-vision: portable build (AVX2 baseline, runs on other PCs)")
else()
  # this PC's instruction set; a build folder that was portable before gets a fresh native build's settings back
  set(GGML_NATIVE ON CACHE BOOL "" FORCE)
  set(GGML_OPENMP ON CACHE BOOL "" FORCE)
  foreach(_f GGML_AVX GGML_AVX2 GGML_FMA GGML_F16C GGML_BMI2)
    set(${_f} OFF CACHE BOOL "" FORCE)
  endforeach()
  message(STATUS "quchen-vision: native build for this CPU (QUCHEN_PORTABLE=OFF) - not for other PCs")
endif()
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)
set(GGML_CUDA ${QUCHEN_VISION_CUDA} CACHE BOOL "" FORCE)
set(GGML_HIP ${QUCHEN_VISION_HIP} CACHE BOOL "" FORCE)
if(APPLE)
  # One program for both readers: quchen-vision --gpu runs the encoder on the Metal GPU, without --gpu on the CPU (Apple Silicon always
  # has the Metal framework, the engine needs it too).  The Metal shaders are embedded in the binary and compiled by macOS when the
  # reader starts, so nothing but the program has to be shipped.  No -march flag: the default target (an M1) runs on every Apple
  # Silicon Mac, and ggml's CPU path has no BF16 vector kernel on ARM (measured on an M4: the same ~50 s for a 260-token picture with
  # -march=armv8.6-a+bf16+i8mm as without), so a faster target would only risk the M1.
  set(GGML_METAL ${QUCHEN_VISION_METAL} CACHE BOOL "" FORCE)
  set(GGML_METAL_EMBED_LIBRARY ${QUCHEN_VISION_METAL} CACHE BOOL "" FORCE)
endif()
set(GGML_SYCL ${QUCHEN_VISION_SYCL} CACHE BOOL "" FORCE)
if(QUCHEN_VISION_SYCL)
  set(GGML_SYCL_TARGET "INTEL" CACHE STRING "" FORCE)
endif()
if(QUCHEN_VISION_HIP)
  # the engine's HIP build says the same (cmake/hip_backend.cmake); ggml-hip reads AMDGPU_TARGETS / CMAKE_HIP_ARCHITECTURES
  set(AMDGPU_TARGETS "${QUCHEN_VISION_HIP_ARCHS}" CACHE STRING "" FORCE)
  set(GPU_TARGETS "${QUCHEN_VISION_HIP_ARCHS}" CACHE STRING "" FORCE)
  set(CMAKE_HIP_ARCHITECTURES "${QUCHEN_VISION_HIP_ARCHS}" CACHE STRING "" FORCE)
  # #3359: a Linux toolchain links a PIE; ggml-hip's objects must be position independent (the engine's HIP build says the same in
  # cmake/hip_backend.cmake).  Only for the HIP reader: the other readers' builds stay as they were.
  set(CMAKE_POSITION_INDEPENDENT_CODE ON)
endif()

add_subdirectory(${LLAMA_DIR} llama EXCLUDE_FROM_ALL)

add_executable(quchen-vision quchen_vision.cpp)
if(MSVC)   # #3202: the ANSI code page of the process is UTF-8, so a Cyrillic model folder reaches the reader intact (see ../../CMakeLists.txt)
  target_sources(quchen-vision PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/quchen-utf8.manifest)
endif()
target_link_libraries(quchen-vision PRIVATE mtmd llama)
target_compile_features(quchen-vision PRIVATE cxx_std_17)
set_target_properties(quchen-vision PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
if(QUCHEN_VISION_HIP)
  # beside quchen (and, in a component, the CPU reader "quchen-vision"): the GPU reader is its own program, so a PC where
  # the HIP runtime does not load still has the CPU one to fall back on
  set_target_properties(quchen-vision PROPERTIES OUTPUT_NAME quchen-vision-hip)
  string(REPLACE ";" "," _hip_archs "${QUCHEN_VISION_HIP_ARCHS}")
  target_compile_definitions(quchen-vision PRIVATE QUCHEN_VISION_HIP QUCHEN_VISION_HIP_ARCHS="${_hip_archs}")
endif()
if(APPLE AND QUCHEN_VISION_METAL)
  target_compile_definitions(quchen-vision PRIVATE QUCHEN_VISION_METAL)
endif()
if(QUCHEN_VISION_SYCL)
  # the Intel GPU reader is its own program too, beside the CPU reader "quchen-vision" it falls back on
  set_target_properties(quchen-vision PROPERTIES OUTPUT_NAME quchen-vision-sycl)
  target_compile_definitions(quchen-vision PRIVATE QUCHEN_VISION_SYCL)
endif()
if(WIN32 AND QUCHEN_VISION_HIP)
  # hipblas.dll (and rocblas.dll behind it) live in rocm\bin of the engine package: loaded on first use, after main() has put that folder on
  # the DLL search path, so the reader starts from any PATH and says "no GPU" itself where there is none
  target_link_libraries(quchen-vision PRIVATE delayimp)
  target_link_options(quchen-vision PRIVATE -Wl,/delayload:hipblas.dll)
endif()
if(UNIX AND NOT APPLE)
  # the libraries it needs are the ones in its own folder (a component folder is relocatable): RUNPATH $ORIGIN
  set_target_properties(quchen-vision PROPERTIES BUILD_WITH_INSTALL_RPATH ON INSTALL_RPATH "$ORIGIN")
  target_link_options(quchen-vision PRIVATE -Wl,--enable-new-dtags)
endif()
if(QUCHEN_VISION_SYCL AND UNIX AND NOT APPLE)
  # libsycl and the OpenMP runtime live in the oneAPI compiler's lib folder, which only a sourced setvars.sh puts on the search path:
  # recorded in the program, it starts from a plain shell (the server starts it with the PC's own environment)
  get_filename_component(_icpx_bin "${CMAKE_CXX_COMPILER}" REALPATH)
  get_filename_component(_icpx_bin "${_icpx_bin}" DIRECTORY)
  get_filename_component(_icpx_lib "${_icpx_bin}/../lib" ABSOLUTE)
  set_target_properties(quchen-vision PROPERTIES INSTALL_RPATH "$ORIGIN;${_icpx_lib}")
endif()

# opens a GGUF that has tensor types llama.cpp does not know (a Gyro quantization's TQK6 / TQK7) for its vocabulary only
add_executable(quchen-vision-gguf-test EXCLUDE_FROM_ALL gguf_meta_test.cpp)
target_link_libraries(quchen-vision-gguf-test PRIVATE llama)
target_compile_features(quchen-vision-gguf-test PRIVATE cxx_std_17)
set_target_properties(quchen-vision-gguf-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# the HIP reader's architecture check (gpu_arch.h), without a GPU
add_executable(quchen-vision-arch-test EXCLUDE_FROM_ALL gpu_arch_test.cpp)
target_compile_features(quchen-vision-arch-test PRIVATE cxx_std_17)
set_target_properties(quchen-vision-arch-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
