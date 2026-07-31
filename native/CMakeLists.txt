cmake_minimum_required(VERSION 3.10)
project(kinect_grabber CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# libfreenect2 is built from source into a prefix rather than installed system
# wide, because the source we build is our own: third_party/libfreenect2 is
# upstream v0.2.1 plus the sub-9 fix, tracked in this repo so a rebuild does not
# depend on a clone of a branch that pins nothing. See third_party/UPSTREAM.md.
# vendor/prefix is where that build lands and is gitignored - source is tracked,
# artifacts are not. -DFREENECT2_ROOT=... points at any other prefix; the Pi's is
# ~/freenect2. Its own freenect2Config.cmake is not used: it bakes the install
# path in with NO_DEFAULT_PATH, so it would ignore the override.
set(FREENECT2_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/prefix"
    CACHE PATH "libfreenect2 install prefix")

find_path(FREENECT2_INCLUDE_DIR libfreenect2/libfreenect2.hpp
          HINTS "${FREENECT2_ROOT}/include")
find_library(FREENECT2_LIBRARY freenect2
             HINTS "${FREENECT2_ROOT}/lib")

if(NOT FREENECT2_INCLUDE_DIR OR NOT FREENECT2_LIBRARY)
  message(FATAL_ERROR "libfreenect2 not found under ${FREENECT2_ROOT} - build it there or pass -DFREENECT2_ROOT=")
endif()

# turbojpeg is an ordinary system package on Linux but keg-only under Homebrew,
# so it is off the default search path on macOS and needs an explicit hint.
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
  pkg_check_modules(PC_TURBOJPEG QUIET libturbojpeg)
endif()

find_path(TURBOJPEG_INCLUDE_DIR turbojpeg.h
          HINTS ${PC_TURBOJPEG_INCLUDE_DIRS}
                /opt/homebrew/opt/jpeg-turbo/include
                /usr/local/opt/jpeg-turbo/include)
find_library(TURBOJPEG_LIBRARY turbojpeg
             HINTS ${PC_TURBOJPEG_LIBRARY_DIRS}
                   /opt/homebrew/opt/jpeg-turbo/lib
                   /usr/local/opt/jpeg-turbo/lib)

if(NOT TURBOJPEG_INCLUDE_DIR OR NOT TURBOJPEG_LIBRARY)
  message(FATAL_ERROR "turbojpeg not found - install libturbojpeg0-dev or brew install jpeg-turbo")
endif()

add_executable(grabber grabber.cpp)

# The differential harness runner. Built from one source against two different
# libfreenect2 prefixes - ours and a pristine upstream one - so the comparison
# is between two independently linked libraries rather than between a library
# and a renamed recompile of itself. It needs no turbojpeg and no device.
add_executable(reg-runner harness/reg-runner.cpp)
target_include_directories(reg-runner PRIVATE "${FREENECT2_INCLUDE_DIR}")
target_link_libraries(reg-runner PRIVATE "${FREENECT2_LIBRARY}")

target_include_directories(grabber PRIVATE
  "${FREENECT2_INCLUDE_DIR}"
  "${TURBOJPEG_INCLUDE_DIR}"
)

target_link_libraries(grabber PRIVATE
  "${FREENECT2_LIBRARY}"
  "${TURBOJPEG_LIBRARY}"
)

# Let the binary find libfreenect2 without DYLD_LIBRARY_PATH or LD_LIBRARY_PATH
get_filename_component(FREENECT2_LIBDIR "${FREENECT2_LIBRARY}" DIRECTORY)
# reg-runner needs this even more than grabber does: the whole harness rests on
# the oracle build loading the oracle's libfreenect2 and ours loading ours, and
# a runner that fell back to a system copy would compare a build against itself
# and report a clean pass.
set_target_properties(grabber reg-runner PROPERTIES
  BUILD_RPATH "${FREENECT2_LIBDIR}"
  INSTALL_RPATH "${FREENECT2_LIBDIR}"
)
