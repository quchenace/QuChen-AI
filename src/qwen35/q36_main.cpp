// src/qwen35/q36_main.cpp - quchen-q36: the Qwen3.6 engine path on its own (the same entry point `quchen` switches
// to for a qwen35moe model).
#include "quchen/qwen35/engine.hpp"

int main(int argc, char** argv) { return quchen::qwen35::run(argc, argv); }
