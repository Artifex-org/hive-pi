// Linux transport primitive only: no identity, session or authorization proof.
// SDK bootstrap owns fd3; it must already be a connected nonblocking Unix
// seqpacket socket. No descriptor numbers, destinations or flags come from JS.
#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>

#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#ifndef __linux__
#error SDK private IPC requires Linux
#endif

#define SDK_BOOTSTRAP_FD 3
#define SDK_BOOTSTRAP_LIMIT 4096

// Burn before validation/effects. Never restore on invalid input, interruption,
// EAGAIN, short send, lost reply, JS exceptions, model reset or another session.
static atomic_flag bootstrap_used = ATOMIC_FLAG_INIT;

static napi_value refused(napi_env env) {
  napi_throw_error(env, "SDK_PRIVATE_TRANSPORT", "SDK private bootstrap unavailable");
  return NULL;
}

static int private_socket(int fd) {
  int flags = fcntl(fd, F_GETFL);
  int type = 0, domain = 0;
  socklen_t type_size = sizeof(type), domain_size = sizeof(domain);
  return flags >= 0 && (flags & O_NONBLOCK) != 0 &&
         getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0 &&
         type_size == sizeof(type) && type == SOCK_SEQPACKET &&
         getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &domain_size) == 0 &&
         domain_size == sizeof(domain) && domain == AF_UNIX;
}

static napi_value send_bootstrap_once(napi_env env, napi_callback_info info) {
  if (atomic_flag_test_and_set_explicit(&bootstrap_used, memory_order_relaxed)) {
    return refused(env);
  }
  size_t argc = 2, length = 0;
  napi_value args[2];
  bool is_buffer = false;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_is_buffer(env, args[0], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, args[0], &data, &length) != napi_ok || data == NULL ||
      length == 0 || length > SDK_BOOTSTRAP_LIMIT) {
    return refused(env);
  }

  unsigned char captured[SDK_BOOTSTRAP_LIMIT];
  memcpy(captured, data, length);
  int held = fcntl(SDK_BOOTSTRAP_FD, F_DUPFD_CLOEXEC, SDK_BOOTSTRAP_FD + 1);
  if (held < 0) return refused(env);
  if (!private_socket(held)) {
    close(held);
    return refused(env);
  }
  struct iovec vector = {.iov_base = captured, .iov_len = length};
  struct msghdr message = {.msg_iov = &vector, .msg_iovlen = 1};
  // Exactly one direct syscall invocation: no libc send wrapper, libuv,
  // blocking wait, EINTR retry, redirect, fallback or message reconstruction.
  long sent = syscall(SYS_sendmsg, held, &message, MSG_DONTWAIT | MSG_NOSIGNAL);
  close(held);
  if (sent < 0 || (size_t)sent != length) return refused(env);

  napi_value result;
  if (napi_get_boolean(env, true, &result) != napi_ok) return refused(env);
  // Local complete send is NOT a parent reply, client grant or acknowledgment.
  return result;
}

static napi_value boottime_nanos(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  struct timespec now;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0 ||
      clock_gettime(CLOCK_BOOTTIME, &now) != 0 || now.tv_sec < 0 ||
      now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      (uint64_t)now.tv_sec > (UINT64_MAX - (uint64_t)now.tv_nsec) / 1000000000) {
    return refused(env);
  }
  uint64_t value = (uint64_t)now.tv_sec * 1000000000 + (uint64_t)now.tv_nsec;
  napi_value result;
  if (napi_create_bigint_uint64(env, value, &result) != napi_ok) return refused(env);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"sendBootstrapOnce", NULL, send_bootstrap_once, NULL, NULL, NULL, napi_default, NULL},
      {"boottimeNanos", NULL, boottime_nanos, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) return refused(env);
  return exports;
}

NAPI_MODULE(sdk_private_ipc, initialize)
