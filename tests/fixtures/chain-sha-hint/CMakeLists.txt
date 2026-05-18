cmake_minimum_required(VERSION 3.14)
project(sha_hint_example)

set(FMT_COMMIT "407c905e45ad75fc29bf0f9bb7c5c2fd3475976f")  # 12.1.0
set(SPDLOG_COMMIT "79524ddd08a4ec981b7fea76afd08ee05f83755d")

include(FetchContent)
include(cmake/fetch.cmake)

FetchContent_MakeAvailable(fmt spdlog)
