cmake_minimum_required(VERSION 3.14)
project(inline_wins)

set(FMT_COMMIT "407c905e45ad75fc29bf0f9bb7c5c2fd3475976f")  # 13.0.0

include(FetchContent)
include(cmake/fetch.cmake)

FetchContent_MakeAvailable(fmt)
