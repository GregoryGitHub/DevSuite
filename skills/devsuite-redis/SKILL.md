---
name: devsuite-redis
description: Inspect and debug the user's Redis servers saved in Dev Suite (standalone, Cluster, Sentinel, TLS, SSH tunnel) with the `devsuite redis` CLI — server info (memory, clients, ops/s, hit rate, keyspace), list keys with SCAN, read typed values (string, hash, list, set, zset, stream with consumer groups, JSON), TTLs, slowlog, connected clients, memory analysis by prefix/type, MONITOR and Pub/Sub for a few seconds, and (only when asked) set/delete keys or run write commands. Use when the user asks about their cache, sessions, Redis keys, memory usage, slow commands or Redis streams/queues.
---

# Redis (`devsuite redis`)

Uses the connections saved in the app (passwords stay in the OS vault). See the `devsuite` skill for output format and safety flags; always pass `--json`.

## Look around

```
devsuite redis conns --json
devsuite redis info Local --json                          # version, mode, memory, clients, ops/s, hit rate, evictions, keyspace per db
devsuite redis info Local --section replication --json   # any raw INFO section
devsuite redis keys Local --pattern "sessao:*" --json     # SCAN (never KEYS); add --type hash, --db 2, --limit 5000
devsuite redis get Local usuario:42:perfil --json         # typed value + ttl + memory; collections up to --limit items
devsuite redis get Local cache:produto:7 --parse --json   # string holding JSON -> parsed
devsuite redis get Local pedidos --limit 20 --json        # stream: newest entries + consumer groups (pending, lag)
devsuite redis ttl Local sessao:abc --json
devsuite redis exec Local "XPENDING pedidos workers - + 10" --json   # any read command, redis-cli syntax
devsuite redis exec Local @comandos.txt --db 1 --json                # several lines = several commands
```

## Debug

```
devsuite redis slowlog Local --count 20 --json
devsuite redis clients Local --json
devsuite redis memory Local --limit 100000 --pause 5 --json          # by type, prefix (a:b:*), TTL bucket, biggest keys
devsuite redis memory Local --pattern "cache:*" --depth 2 --json
devsuite redis monitor Local --seconds 5 --filter usuario --json     # one event per command; heavy on busy servers, keep it short
devsuite redis subscribe Local --pattern "eventos:*" --seconds 30 --json
devsuite redis nodes Cluster --json                                  # Cluster: nodes, roles, slots
```

In a Cluster, `info`, `slowlog`, `clients` and `exec` accept `--node host:port`; `keys` and `memory` already walk every master.

## Writing (only when the user asked)

```
devsuite redis set Local feature:nova-tela on --write                 # keeps the existing TTL unless --ttl / --reset-ttl
devsuite redis set Local sessao:abc @valor.json --ttl 1h --write
devsuite redis ttl Local sessao:abc --set 30min --write               # or --persist
devsuite redis del Local cache:produto:7 --write --yes
devsuite redis del Local --pattern "cache:produtos:*" --write --yes   # SCAN + UNLINK in batches
devsuite redis exec Local "HSET usuario:42 plano pro" --write
devsuite redis publish Local pedidos.novos "{\"id\":1}" --write
```

- Any command with the `write` flag (per `COMMAND INFO`) needs `--write`; FLUSHDB/FLUSHALL, CONFIG SET, CLIENT KILL and similar also need `--confirm "<connection>"` on connections marked "ambiente sensível". Read-only connections refuse writes.
- `SUBSCRIBE`, `MONITOR` and `SELECT` are not accepted by `exec`: use `subscribe`, `monitor` and `--db` (or a `select N` line).
- Prefer `keys`/`memory` over `exec "KEYS *"` (KEYS blocks the server).

## Connections

```
devsuite redis conn add --name Local --url redis://localhost:6379 --test
devsuite redis conn add --name Cache --url rediss://default@cache.example.com:6380 --password - --test   # password from stdin
devsuite redis conn add --name Cluster --mode cluster --node 10.0.0.1:7000 --node 10.0.0.2:7000
devsuite redis conn add --name HA --mode sentinel --node s1:26379 --node s2:26379 --master mymaster
devsuite redis conn remove Local --yes
```

SSH tunnels and custom CA certificates are configured in the app's connection dialog.
