#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

struct traversal_result {
  uint64_t changed;
  uint64_t symlinks_skipped;
};

static void fail_errno(const char *operation);
static void fail_message(const char *message);

static unsigned long descriptor_mount_id(int fd) {
#ifdef __linux__
  char descriptor_path[64];
  int length = snprintf(descriptor_path, sizeof(descriptor_path), "/proc/self/fdinfo/%d", fd);
  if (length < 0 || (size_t)length >= sizeof(descriptor_path)) {
    fail_message("could not address descriptor mount metadata");
  }
  FILE *metadata = fopen(descriptor_path, "r");
  if (metadata == NULL) fail_errno("descriptor mount inspection open");
  char line[256];
  unsigned long mount_id = 0;
  while (fgets(line, sizeof(line), metadata) != NULL) {
    if (sscanf(line, "mnt_id:%lu", &mount_id) == 1) break;
  }
  if (ferror(metadata)) {
    fclose(metadata);
    fail_errno("descriptor mount inspection read");
  }
  if (fclose(metadata) != 0) fail_errno("descriptor mount inspection close");
  if (mount_id == 0) fail_message("descriptor mount metadata is unavailable");
  return mount_id;
#else
  (void)fd;
  return 0;
#endif
}

#ifdef COMPOSEBASTION_STORAGE_HELPER_TESTING
static void test_pause_after_inspection(const char *name) {
  const char *entry = getenv("COMPOSEBASTION_STORAGE_TEST_PAUSE_ENTRY");
  const char *ready = getenv("COMPOSEBASTION_STORAGE_TEST_READY_FILE");
  const char *release = getenv("COMPOSEBASTION_STORAGE_TEST_RELEASE_FILE");
  if (entry == NULL || ready == NULL || release == NULL || strcmp(entry, name) != 0) return;
  int ready_fd = open(ready, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
  if (ready_fd < 0) fail_errno("test synchronization creation");
  if (close(ready_fd) != 0) fail_errno("test synchronization close");
  for (unsigned int attempt = 0; attempt < 10000; attempt += 1) {
    if (access(release, F_OK) == 0) return;
    if (errno != ENOENT) fail_errno("test synchronization inspection");
    usleep(1000);
  }
  fail_message("test synchronization timed out");
}
#else
static void test_pause_after_inspection(const char *name) {
  (void)name;
}
#endif

static void fail_errno(const char *operation) {
  fprintf(stderr, "Backup storage preparation failed during %s: %s\n", operation, strerror(errno));
  exit(EXIT_FAILURE);
}

static void fail_message(const char *message) {
  fprintf(stderr, "Backup storage preparation failed: %s\n", message);
  exit(EXIT_FAILURE);
}

static unsigned long parse_identity(const char *name, const char *text) {
  if (text == NULL || *text == '\0') fail_message("numeric identity is missing");
  errno = 0;
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value == 0 || value > INT32_MAX) {
    fprintf(stderr, "Backup storage preparation failed: %s must be between 1 and %d\n", name, INT32_MAX);
    exit(EXIT_FAILURE);
  }
  return value;
}

static void change_opened_ownership(
  int fd,
  const struct stat *stats,
  uid_t uid,
  gid_t gid,
  struct traversal_result *result
) {
  if (stats->st_uid == uid && stats->st_gid == gid) return;
  if (fchown(fd, uid, gid) != 0) fail_errno("descriptor ownership change");
  result->changed += 1;
}

static void prepare_directory(
  int directory_fd,
  dev_t root_device,
  unsigned long root_mount_id,
  uid_t uid,
  gid_t gid,
  struct traversal_result *result
);

static void prepare_entry(
  int parent_fd,
  const char *name,
  dev_t root_device,
  unsigned long root_mount_id,
  uid_t uid,
  gid_t gid,
  struct traversal_result *result
) {
  for (unsigned int attempt = 0; attempt < 8; attempt += 1) {
    struct stat observed;
    if (fstatat(parent_fd, name, &observed, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) return;
      fail_errno("entry inspection");
    }
    if (observed.st_dev != root_device) fail_message("backup storage contains a nested filesystem");
    test_pause_after_inspection(name);
    if (S_ISLNK(observed.st_mode)) {
      result->symlinks_skipped += 1;
      return;
    }

    if (S_ISDIR(observed.st_mode)) {
      int child_fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child_fd < 0) {
        if (errno == ENOENT || errno == ENOTDIR || errno == ELOOP) continue;
        fail_errno("directory open");
      }
      struct stat opened;
      if (fstat(child_fd, &opened) != 0) {
        close(child_fd);
        fail_errno("directory descriptor inspection");
      }
      if (!S_ISDIR(opened.st_mode)) {
        close(child_fd);
        continue;
      }
      if (opened.st_dev != observed.st_dev || opened.st_ino != observed.st_ino) {
        close(child_fd);
        continue;
      }
      if (opened.st_dev != root_device) {
        close(child_fd);
        fail_message("backup storage contains a nested filesystem");
      }
      if (descriptor_mount_id(child_fd) != root_mount_id) {
        close(child_fd);
        fail_message("backup storage contains a nested filesystem");
      }
      prepare_directory(child_fd, root_device, root_mount_id, uid, gid, result);
      change_opened_ownership(child_fd, &opened, uid, gid, result);
      if (close(child_fd) != 0) fail_errno("directory close");
      return;
    }

    if (S_ISREG(observed.st_mode)) {
      int child_fd = openat(parent_fd, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
      if (child_fd < 0) {
        if (errno == ENOENT || errno == ELOOP) continue;
        fail_errno("file open");
      }
      struct stat opened;
      if (fstat(child_fd, &opened) != 0) {
        close(child_fd);
        fail_errno("file descriptor inspection");
      }
      if (!S_ISREG(opened.st_mode)) {
        close(child_fd);
        continue;
      }
      if (opened.st_dev != observed.st_dev || opened.st_ino != observed.st_ino) {
        close(child_fd);
        continue;
      }
      if (opened.st_dev != root_device) {
        close(child_fd);
        fail_message("backup storage contains a nested filesystem");
      }
      if (descriptor_mount_id(child_fd) != root_mount_id) {
        close(child_fd);
        fail_message("backup storage contains a nested filesystem");
      }
      change_opened_ownership(child_fd, &opened, uid, gid, result);
      if (close(child_fd) != 0) fail_errno("file close");
      return;
    }

    fail_message("backup storage contains an unsupported special file");
  }

  fail_message("backup storage entry changed repeatedly during preparation");
}

static void prepare_directory(
  int directory_fd,
  dev_t root_device,
  unsigned long root_mount_id,
  uid_t uid,
  gid_t gid,
  struct traversal_result *result
) {
  int iteration_fd = dup(directory_fd);
  if (iteration_fd < 0) fail_errno("directory descriptor duplication");
  DIR *directory = fdopendir(iteration_fd);
  if (directory == NULL) {
    close(iteration_fd);
    fail_errno("directory iteration open");
  }

  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    prepare_entry(directory_fd, entry->d_name, root_device, root_mount_id, uid, gid, result);
    errno = 0;
  }
  if (errno != 0) {
    closedir(directory);
    fail_errno("directory iteration");
  }
  if (closedir(directory) != 0) fail_errno("directory iteration close");
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "Usage: %s ABSOLUTE_BACKUP_ROOT UID GID\n", argv[0]);
    return EXIT_FAILURE;
  }
  if (argv[1][0] != '/' || strcmp(argv[1], "/") == 0) fail_message("backup root must be a safe absolute path");

  uid_t uid = (uid_t)parse_identity("UID", argv[2]);
  gid_t gid = (gid_t)parse_identity("GID", argv[3]);
  int root_fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) fail_errno("backup root open");

  struct stat root_stats;
  if (fstat(root_fd, &root_stats) != 0) {
    close(root_fd);
    fail_errno("backup root inspection");
  }
  if (!S_ISDIR(root_stats.st_mode)) {
    close(root_fd);
    fail_message("backup root must be a real directory");
  }

  struct traversal_result result = {0, 0};
  unsigned long root_mount_id = descriptor_mount_id(root_fd);
  prepare_directory(root_fd, root_stats.st_dev, root_mount_id, uid, gid, &result);
  change_opened_ownership(root_fd, &root_stats, uid, gid, &result);
  if (close(root_fd) != 0) fail_errno("backup root close");

  printf(
    "{\"changed\":%" PRIu64 ",\"symlinksSkipped\":%" PRIu64 "}\n",
    result.changed,
    result.symlinks_skipped
  );
  return EXIT_SUCCESS;
}
