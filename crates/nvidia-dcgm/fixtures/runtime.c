/* Synthetic ABI shim, not hardware data.
 * Layout declarations derived from NVIDIA DCGM v4.7.0, Apache-2.0.
 * Copyright (c) 2025-2026 NVIDIA CORPORATION. All rights reserved.
 * See NOTICE and LICENSE-APACHE. */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int group; unsigned id; } Entity;
typedef struct { unsigned version, persist, timeout, unix_socket; } Connect;
typedef struct {
    unsigned version; int group; unsigned id; unsigned short field, tag;
    int status; unsigned unused; int64_t time;
    union { int64_t i; double d; char s[256]; char blob[4096]; } value;
} Value;
typedef struct { unsigned short major, minor; unsigned count; unsigned short fields[64]; } Group;
typedef struct { unsigned version, unused, gpu, count; Group groups[10]; } Groups;
#include "a10.h"
_Static_assert(sizeof(Value) == 4128, "value stride");
_Static_assert(offsetof(Value, value) == 32, "union offset");
_Static_assert(sizeof(Groups) == 1376, "profile groups");

static void log_call(const char *call) {
    const char *path = getenv("RECOUNT_DCGM_FIXTURE_LOG");
    if (!path) return;
    FILE *file = fopen(path, "a");
    if (file) { fprintf(file, "%s\n", call); fclose(file); }
}
int dcgmInit(void) { log_call("init"); return 0; }
int dcgmShutdown(void) {
    log_call("shutdown");
    const char *mode = getenv("RECOUNT_DCGM_FIXTURE_MODE");
    return mode && !strcmp(mode, "bad-shutdown") ? -3 : 0;
}
int dcgmConnect_v2(const char *address, Connect *params, uintptr_t *handle) {
    if (strcmp(address, "127.0.0.1:5555") || params->version != 0x02000010 ||
        params->persist || params->timeout != 500) return -1;
    *handle = 1; log_call("connect"); return 0;
}
int dcgmDisconnect(uintptr_t handle) { log_call("disconnect"); return handle == 1 ? 0 : -1; }
int dcgmStartEmbedded(int mode, uintptr_t *handle) {
    log_call("start"); *handle = 1; return mode == 1 ? 0 : -1;
}
int dcgmStopEmbedded(uintptr_t handle) { log_call("stop"); return handle == 1 ? 0 : -1; }
int dcgmGetAllDevices(uintptr_t handle, unsigned *ids, int *count) {
    (void)handle; ids[0] = 7; *count = 1;
    const char *mode = getenv("RECOUNT_DCGM_FIXTURE_MODE");
    if (mode && !strcmp(mode, "partial")) { ids[1] = 8; *count = 2; }
    if (mode && !strcmp(mode, "zero-devices")) *count = 0;
    return 0;
}
int dcgmGetGpuInstanceHierarchy(uintptr_t handle, void *hierarchy) {
    (void)handle; (void)hierarchy; return -6;
}
int dcgmProfGetSupportedMetricGroups(uintptr_t handle, Groups *groups) {
    (void)handle;
    if (groups->version != 0x03000560 || groups->gpu != 7) return -12;
    const char *mode = getenv("RECOUNT_DCGM_FIXTURE_MODE");
    if (mode && !strcmp(mode, "a10")) return a10_groups(groups);
    groups->count = 3;
    groups->groups[0] = (Group){1, 1, 5, {1001, 1002, 1003, 1004, 1007}};
    groups->groups[1] = (Group){1, 2, 1, {1006}};
    groups->groups[2] = (Group){1, 3, 1, {1008}};
    return 0;
}
int dcgmGroupCreate(uintptr_t h, int type, const char *name, uintptr_t *id) {
    (void)h; (void)type; (void)name;
    const char *mode = getenv("RECOUNT_DCGM_FIXTURE_MODE");
    *id = mode && !strcmp(mode, "zero-handles") ? 0 : 4;
    log_call("group"); return 0;
}
int dcgmGroupAddEntity(uintptr_t h, uintptr_t group, int kind, unsigned id) {
    (void)h; (void)group; return kind == 1 && id == 7 ? 0 : -1;
}
int dcgmGroupDestroy(uintptr_t h, uintptr_t group) {
    (void)h; (void)group; log_call("destroy-group"); return 0;
}
int dcgmFieldGroupCreate(uintptr_t h, int count, unsigned short *fields,
                        const char *name, uintptr_t *id) {
    (void)h; (void)name;
    const char *mode = getenv("RECOUNT_DCGM_FIXTURE_MODE");
    if (mode && !strcmp(mode, "a10"))
        for (int i = 0; i < count; i++) if (fields[i] == 1006) return -1;
    *id = mode && !strcmp(mode, "zero-handles") ? 0 : 5;
    return count > 0 && count < 128 ? 0 : -1;
}
int dcgmFieldGroupDestroy(uintptr_t h, uintptr_t fields) {
    (void)h; (void)fields; log_call("destroy-fields"); return 0;
}
int dcgmWatchFields(uintptr_t h, uintptr_t group, uintptr_t fields,
                   int64_t interval, double age, int count) {
    (void)h; (void)group; (void)fields;
    log_call("watch"); return interval >= 1000000 && age >= 3 && count == 3 ? 0 : -1;
}
int dcgmUnwatchFields(uintptr_t h, uintptr_t group, uintptr_t fields) {
    (void)h; (void)group; (void)fields; log_call("unwatch"); return 0;
}
int dcgmEntitiesGetLatestValues(uintptr_t h, Entity *entities, unsigned entity_count,
                               unsigned short *fields, unsigned count, unsigned flags, Value *out) {
    (void)h;
    if (entity_count != 1 || count > 128) return -1;
    const char *mode = getenv("RECOUNT_DCGM_FIXTURE_MODE");
    for (unsigned i = 0; i < count; i++) {
        unsigned short field = fields[count - 1 - i]; /* Deliberately reordered. */
        if (field >= 1000 && flags != 0) return -1;
        memset(&out[i], 0, sizeof(Value));
        out[i].version = 0x02001020; out[i].group = entities[0].group;
        out[i].id = entities[0].id; out[i].field = field; out[i].time = 1700000000000000;
        if (mode && !strcmp(mode, "bad-pair")) out[i].id = 999;
        if (mode && !strcmp(mode, "a10") && field != 54) {
            if (!a10_value(field, &out[i])) out[i].status = -14;
            continue;
        }
        out[i].tag = 'i'; out[i].value.i = 42;
        if (field == 54) {
            out[i].tag = 's'; strcpy(out[i].value.s, "GPU-01234567-89ab-cdef-0123-456789abcdef");
            if (entities[0].id == 8) out[i].status = -17;
        } else if (field == 155 || (field >= 1001 && field <= 1008)) {
            out[i].tag = 'd'; out[i].value.d = field == 155 ? 70.5 : 0.5;
            if (field == 1004) out[i].value.d = 0.928;
            if (field == 1006) out[i].value.d = 140737488355330.0; /* finite unsupported */
        }
    }
    return 0;
}
