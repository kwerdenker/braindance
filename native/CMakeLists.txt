cmake_minimum_required(VERSION 3.10)
project(kinect_grabber CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_BUILD_TYPE Release)

set(PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/prefix")
set(TURBOJPEG_ROOT "/opt/homebrew/opt/jpeg-turbo")

add_executable(grabber grabber.cpp)

target_include_directories(grabber PRIVATE
  "${PREFIX}/include"
  "${TURBOJPEG_ROOT}/include"
)

target_link_libraries(grabber PRIVATE
  "${PREFIX}/lib/libfreenect2.dylib"
  "${TURBOJPEG_ROOT}/lib/libturbojpeg.dylib"
)

# Let the binary find libfreenect2.dylib without DYLD_LIBRARY_PATH
set_target_properties(grabber PROPERTIES
  BUILD_RPATH "${PREFIX}/lib"
  INSTALL_RPATH "${PREFIX}/lib"
)
