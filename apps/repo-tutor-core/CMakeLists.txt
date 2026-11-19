# 可执行文件进程边界。stdio JSON-RPC framing 和协议分发都在这一层，
# 不碰 Core 内部。

add_executable(repo_tutor_core_cli
  main.cpp
  protocol.cpp
)
set_target_properties(repo_tutor_core_cli PROPERTIES
  OUTPUT_NAME "repo-tutor-core"
)
target_link_libraries(repo_tutor_core_cli PRIVATE repo_tutor::core)

# 发布的二进制要能单独跑：不允许依赖 MinGW / libstdc++ 的运行时 DLL。
# 不做这一步，用户的机器上会 STATUS_DLL_NOT_FOUND —— objdump -p 一查就看见。
# 只改链接方式，教学状态机和协议语义不受影响。
option(REPO_TUTOR_STATIC_RUNTIME "静态链接 C++ 运行时，方便单个二进制分发" ON)
if(REPO_TUTOR_STATIC_RUNTIME)
  if(MSVC)
    # GitHub 的 windows runner 是 MSVC，没有 MinGW 的 objdump；/MT 同样得到自包含的 exe。
    set_property(TARGET repo_tutor_core_cli PROPERTY
      MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  elseif(MINGW OR (WIN32 AND CMAKE_CXX_COMPILER_ID MATCHES "Clang"))
    target_link_options(repo_tutor_core_cli PRIVATE -static)
    # 这套 mingw 的 libstdc++ 用 posix 线程模型，静态库之间的引用顺序是关键：
    # 必须成组链接，否则 libgcc_eh 里的 pthread_* 永远解析不到。
    target_link_libraries(repo_tutor_core_cli PRIVATE
      -Wl,--start-group -lstdc++ -lpthread -Wl,--end-group
    )
  elseif(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang" AND NOT APPLE)
    # Linux：libstdc++/libgcc 静态，glibc 仍然动态（静态 glibc 有已知问题）。
    target_link_options(repo_tutor_core_cli PRIVATE -static-libgcc -static-libstdc++)
  endif()
endif()
