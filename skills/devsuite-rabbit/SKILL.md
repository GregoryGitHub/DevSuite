---
name: devsuite-rabbit
description: Monitor and debug the user's RabbitMQ brokers saved in Dev Suite with the `devsuite rabbit` CLI — overview with alarms and DLQs, queues/exchanges/bindings/consumers, peek messages without removing them, watch queue depth over time, search recorded messages, and (only when asked) publish, move/replay DLQ messages, purge or delete. Use when the user asks about their queues, stuck or dead-lettered messages, consumers, or message traffic.
---

# RabbitMQ (`devsuite rabbit`)

Uses the management HTTP API (and AMQP for move/copy and captures) of the connections saved in the app. See the `devsuite` skill for output format and safety flags; always pass `--json`.

## Monitor

```
devsuite rabbit conns --json
devsuite rabbit overview Local --json                    # totals, rates, alarms, DLQs with messages, queues without consumers, nodes
devsuite rabbit queues Local --non-empty --json
devsuite rabbit queues Local --dlq --json
devsuite rabbit queues Local --no-consumers --filter "pedidos*" --json   # filter: text, * wildcards or /regex/
devsuite rabbit queue Local pedidos --json               # details, arguments (DLX, TTL), consumers, bindings
devsuite rabbit exchanges Local --json
devsuite rabbit bindings Local --filter pedidos --json
devsuite rabbit connections Local --json
devsuite rabbit consumers Local --json
devsuite rabbit watch Local --interval 5 --cycles 12 --json          # one event line per cycle; omit --cycles to run until stopped
devsuite rabbit watch Local --queue pedidos --queue pedidos.dlq --interval 2 --cycles 30 --json
```

## Inspect messages

```
devsuite rabbit peek Local pedidos.dlq --count 5 --json  # non-destructive: messages are requeued (marked redelivered)
devsuite rabbit peek Local pedidos.dlq --count 50 --save --json      # also store them in the message log
devsuite rabbit messages --conn Local --search "pedido 123" --since 2h --json
devsuite rabbit messages --queue pedidos --json-path pedido.id --json-value 123 --json
devsuite rabbit message 4711 --json                      # full stored message (headers, body)
```

`peek` returns `properties` (headers, content_type, ids...), `body` (or `body_base64` for binary) and, for dead-lettered messages, `death` (origin queue, reason, count).

## Record traffic

```
devsuite rabbit capture start Local --queue pedidos --name "investigação" --json   # tap: copies messages via bindings, does not consume
devsuite rabbit capture start Local --mode exchange --exchange eventos --routing-key "pedido.*" --json
devsuite rabbit captures Local --json
devsuite rabbit capture stop 3 --json
```

Captures keep running in the app after the CLI exits. `--mode firehose` turns on vhost tracing on the server, so it needs `--write`.

## Change things (only when the user asked)

All of these need `--write`; on connections marked "ambiente sensível" also `--confirm "<connection name>"`:

```
devsuite rabbit publish Local --queue pedidos --body @msg.json --header tenant=a --property content_type=application/json --write --json
devsuite rabbit publish Local --exchange eventos --routing-key pedido.criado --body '{"n":{{n}}}' --repeat 10 --write --json
devsuite rabbit move Local pedidos.dlq --origin --write --json           # replay DLQ messages to where they died (x-death)
devsuite rabbit move Local pedidos.dlq --to-queue pedidos --count 10 --write --json
devsuite rabbit move Local pedidos --to-queue pedidos.copia --copy --write --json
devsuite rabbit consume Local pedidos --count 1 --write --json           # removes (saved to the log first)
devsuite rabbit purge Local pedidos.dlq --write --json
devsuite rabbit declare-queue Local nova --bind amq.direct:nova --arg x-dead-letter-exchange=dlx --write --json
devsuite rabbit delete-queue Local velha --write --json
devsuite rabbit api Local /queues/%2F/pedidos --json                     # raw management API (GET); other methods need --write
```

Move/copy run inside AMQP transactions (no message loss if it fails midway). Prefer `peek` before `consume`/`purge`, and tell the user how many messages will be affected.
