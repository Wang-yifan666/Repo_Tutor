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
