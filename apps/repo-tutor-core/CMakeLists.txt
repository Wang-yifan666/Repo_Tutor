# 可执行文件进程边界。stdio framing、JSON 序列化、协议分发这些
# 后面都会落在这里。Batch 1 只链接 Core 库、打印个版本号，
# 证明这个边界存在就行。

add_executable(repo_tutor_core_cli
  main.cpp
)
set_target_properties(repo_tutor_core_cli PROPERTIES
  OUTPUT_NAME "repo-tutor-core"
)
target_link_libraries(repo_tutor_core_cli PRIVATE repo_tutor::core)
