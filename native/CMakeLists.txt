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

# **Moving the root has to move the library, and on its own it does not.** find_path and
# find_library write their answers into the cache and then skip entirely on any later
# configure that finds those entries already set, so a build directory first configured
# with -DFREENECT2_ROOT=~/freenect2 keeps resolving to ~/freenect2 no matter what root is
# passed afterwards. Measured rather than reasoned: configuring against a foreign prefix
# and then re-running the build script with -DFREENECT2_ROOT=vendor/prefix moved this one
# variable and left FREENECT2_LIBRARY and the grabber's rpath on the foreign copy, exit 0,
# with the script reporting OK over a library it had not built. Dropping the resolved
# paths whenever the root changes is what makes the override mean anything.
if(NOT "${FREENECT2_ROOT}" STREQUAL "${FREENECT2_ROOT_RESOLVED}")
  unset(FREENECT2_INCLUDE_DIR CACHE)
  unset(FREENECT2_LIBRARY CACHE)
endif()

# NO_DEFAULT_PATH rather than HINTS, so the prefix is binding rather than preferred. With
# hints alone a root holding no libfreenect2 falls through to the system search path and
# links whatever is installed there - the same wrong library by a quieter route, and it
# would make the message below false at the moment it matters most.
find_path(FREENECT2_INCLUDE_DIR libfreenect2/libfreenect2.hpp
          PATHS "${FREENECT2_ROOT}/include" NO_DEFAULT_PATH)
find_library(FREENECT2_LIBRARY freenect2
             PATHS "${FREENECT2_ROOT}/lib" NO_DEFAULT_PATH)

if(NOT FREENECT2_INCLUDE_DIR OR NOT FREENECT2_LIBRARY)
  message(FATAL_ERROR "libfreenect2 not found under ${FREENECT2_ROOT} - build it there or pass -DFREENECT2_ROOT=")
endif()

# Recorded only once the pair above resolved, so a configure that failed to find the
# library cannot leave a marker claiming this root was searched successfully.
set(FREENECT2_ROOT_RESOLVED "${FREENECT2_ROOT}" CACHE INTERNAL
    "the prefix FREENECT2_INCLUDE_DIR and FREENECT2_LIBRARY were resolved under")

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
