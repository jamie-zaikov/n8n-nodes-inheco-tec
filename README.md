# n8n-nodes-inheco-tec

An n8n community node for Inheco TEC temperature controllers. The node calls the HTTPS REST API
[`inheco-tec-api`](https://github.com/jamie-zaikov/inheco-tec-api), which drives the controllers
over USB HID on the PC that they are attached to. The node and the API are one pair: see
[Paired API](#paired-api).

Sections of this README:

- [Purpose](#purpose), with the [vendored node base](#vendored-node-base)
- [Install into n8n](#install-into-n8n), with [Build and load](#build-and-load)
- [Credential setup](#credential-setup)
- [Operations](#operations)
- [Error behaviour](#error-behaviour)
- Recovery procedures: [Safety: stop operations and Continue On Fail](#safety-stop-operations-and-continue-on-fail)
  and [Emergency Off recovery](#emergency-off-recovery)
- [Poll pattern (wait for a temperature)](#poll-pattern-wait-for-a-temperature), with the
  [example workflow](#example-workflow)
- [Placeholders](#placeholders), [License](#license) and [Paired API](#paired-api)

## Purpose

The n8n community node for the `inheco-tec` instrument, built on `n8n-node-core`. The npm
package name is the unscoped name `n8n-nodes-inheco-tec`. In the source project the package
defaulted to `"private": true` (FR-5.4) and was flipped to `"private": false` for `npm publish`
only when the node was deliberately shared on the public community channel. This repository is
that public form: its `package.json` has no `private` field, and a release is published to the
public npm registry with `npm publish`.

The node reaches its paired api only over **HTTP**, never by code import. The base URL and the
bearer token come from the node's n8n credential at runtime; the token is referenced, never
committed (NFR-1).

In the source project this node was a member of a root npm workspace and resolved
`n8n-node-core` from that workspace. In this repository the core is vendored: its source files
are under `src/vendor/n8n-node-core/`, and the build, the type check and the tests resolve
`n8n-node-core` to `src/vendor/n8n-node-core/index.ts` (see
[Vendored node base](#vendored-node-base)).

- Node type: `n8n-nodes-inheco-tec.inhecoTec` (display name "Inheco TEC").
- Credential type: `inhecoTecApi`.
- Every operation sends exactly one HTTPS request and returns as soon as the API responds. The
  node has no internal wait-until-temperature loop (FR-14.3). Waiting for a temperature is the
  workflow's job: see [Poll pattern](#poll-pattern-wait-for-a-temperature).

### Vendored node base

The shared TypeScript base `n8n-node-core` (C12, FR-5.2) ships inside this repository under
`src/vendor/n8n-node-core/`. In the source project it was the one base that every instrument node
and every other n8n node imported, a member of the root npm workspace that was always
`"private": true` (NFR-3); it is not published to the npm registry. Here it is bundled into the
built node at build time and is not a package dependency.

#### Surface of the vendored base

| Module | Purpose |
|--------|---------|
| `client` | The HTTP contract to reach the paired instrument API: `InstrumentApiClientOptions`, `buildAuthHeader`, `buildApiRequest`, `DEFAULT_TIMEOUT_MS`. |
| `errors` | The shared error hierarchy: `NodeCoreError`, `InstrumentApiError`. |
| `health` | The `HEALTH_PATH` contract, mirroring `instrument_api_core.health` on the Python side (the service base that is vendored in the paired API). |

#### Dependency direction of the vendored base

This core imports **nothing** back — not `instrument-api-core` and no node. A node reaches its API
only over **HTTP**, never by code import (a module boundary rule of the source project). The
bearer token comes from an n8n credential at runtime; it is referenced, never hard-coded, logged,
or committed (NFR-1).

#### Dependency-free base modules

The base is dependency-free TypeScript, so it builds (`tsc`), lints (`eslint`), and tests
(`vitest`) with only the dev toolchain of this repository. The concrete node adds `n8n-workflow`
and performs the actual HTTP transport; this base ships the pure request-descriptor logic and the
shared types. The Inheco TEC node of this repository is its one consumer.

## Install into n8n

The node runs in a self-hosted n8n instance. It needs the paired API on a host that the n8n host
can reach over HTTPS (TCP 8743 by default).

- **From the n8n editor:** open **Settings → Community nodes → Install**, enter the npm package
  name `n8n-nodes-inheco-tec`, confirm, and wait until n8n reports the node as installed.
- **By hand:** in the n8n custom nodes folder (by default `~/.n8n/nodes`), run
  `npm install n8n-nodes-inheco-tec`, then restart n8n.
- **From a local build:** build this repository (below), pack it with `npm pack`, and install the
  resulting `.tgz` file in the n8n custom nodes folder with `npm install` and the path of that
  file, then restart n8n.

After the install, the node "Inheco TEC" is in the node panel of the n8n editor. Create its
credential next: see [Credential setup](#credential-setup).

### Build and load

```sh
npm run lint
npm run build   # tsc --noEmit, then esbuild -> dist/ (CommonJS)
npm test
```

Run `npm ci` first in a fresh clone; the lock file `package-lock.json` resolves every package from
the public npm registry.

n8n loads community nodes with `require()`. The esbuild bundle is **CommonJS**, inlines
`n8n-node-core` (which is ESM and is not published to the npm registry) and keeps `n8n-workflow`
external (design DD-7, Risk R6). The `n8n` block of `package.json` points n8n at
`dist/credentials/InhecoTecApi.credentials.js` and `dist/nodes/InhecoTec/InhecoTec.node.js`.

## Credential setup

Create one credential of the Inheco TEC credential type (`inhecoTecApi`) per API host:

| Field | Value |
|---|---|
| `baseUrl` | `https://<host>:8743` — the API host and port. It must start with `https://`; plain HTTP is refused. |
| `token` | The bearer token of the API service (an n8n password field). Get it from the API operator; it is the value the service reads from `INHECO_TEC_API_TOKEN`. Never paste it into a workflow, a parameter, an expression or a file. |
| `caCertificate` | Optional. The PEM text of the private platform CA that issued the API server certificate (public data, not a key). Leave it empty only when the server certificate chains to a CA that Node.js already trusts. |

The node always verifies the server certificate; there is no option that turns verification off.
The token is sent as a bearer token in the `Authorization` request header, over HTTPS only,
and is never copied into a node error message (FR-14.1, FR-14.5).

## Operations

One resource, **Controller**, with fifteen operations (FR-14.2). The value column is the
`operation` parameter value in workflow JSON.

| Operation | Value | API request |
|---|---|---|
| Get Status | `getStatus` | `GET /v1/status` |
| Connect | `connect` | `POST /v1/controllers/{cid}/connect` |
| Set Target Temperature | `setTargetTemperature` | `PUT /v1/controllers/{cid}/slots/{sid}/target` |
| Start Temperature Control | `startTemperatureControl` | `POST /v1/controllers/{cid}/slots/{sid}/start` |
| Stop Temperature Control | `stopTemperatureControl` | `POST /v1/controllers/{cid}/slots/{sid}/stop` |
| Stop All | `stopAll` | `POST /v1/stop-all` |
| Get Actual Temperature | `getActualTemperature` | `GET /v1/controllers/{cid}/slots/{sid}/temperature?selector=` |
| Get Target Temperature | `getTargetTemperature` | `GET /v1/controllers/{cid}/slots/{sid}/target` |
| Check At Target | `checkAtTarget` | `GET /v1/controllers/{cid}/slots/{sid}/at-target[?tolerance_c=]` |
| Get Sensor Values | `getSensorValues` | `GET /v1/controllers/{cid}/sensor-values?selector=` |
| Get Device Type | `getDeviceType` | `GET /v1/controllers/{cid}/device-type?slot=` |
| Get Firmware Version | `getFirmwareVersion` | `GET /v1/controllers/{cid}/firmware-version?selector=` |
| Release Controller | `releaseController` | `POST /v1/controllers/{cid}/release` |
| Reacquire Controller | `reacquireController` | `POST /v1/controllers/{cid}/reacquire` |
| Emergency Off | `emergencyOff` | `POST /v1/controllers/{cid}/emergency-off` |

The routes are those of the paired API. The committed snapshot `contract/api-routes.json` holds
the route contract of the API (method, path and query names of each route); the node tests check
every operation against it.

### Parameters

| Parameter | Name | Used by | Default |
|---|---|---|---|
| Controller ID | `controllerId` | every operation except Get Status and Stop All | `0` (range 0-7) |
| Slot ID | `slotId` | the six slot operations (set/get target, start, stop, actual temperature, at-target) | `1` (range 1-6) |
| Temperature (°C) | `temperatureC` | Set Target Temperature (required) | `20` |
| Selector | `selector` | Get Actual Temperature (1-3), Get Sensor Values (0-8), Get Firmware Version (0-4) | `3` / `0` / `0` |
| Tolerance (°C) | `tolerance` | Check At Target | `0` = use the slot's configured tolerance; else 0.1-5.0 |
| Slot | `deviceSlot` | Get Device Type | `0` (0 = the controller itself, 1-6 = a slot) |
| Confirm | `confirm` | Emergency Off (required) | `false` |
| Timeout (ms) | `timeoutMs` | every operation | `120000` (max 2147483647) |

The API owns every range and limit check. A target outside the slot's limits is refused with HTTP
422 and the effective limits.

### Response fields used by workflows

- **Check At Target** returns `controller_id`, `slot_id`, `at_target` (boolean), `actual_c`,
  `target_c`, `tolerance_c` and `selector`. It is **one instantaneous reading** — there is no
  "stable for N seconds" criterion in the API (FR-8.9).
- **Set Target Temperature** returns `target_c` and a `warnings` list.
- **Connect** and **Reacquire Controller** return `state`, `stopped_slots` and
  `emergency_off_cleared`.
- **Stop All** returns `outcomes`: one entry per slot with `outcome` (`stopped`, `failed`,
  `not_delivered` or `skipped`) and `failure`. A 200 response can still carry `skipped` slots;
  read the per-slot outcomes.
- **Emergency Off** returns `controller_id` and `emergency_off_active`.

## Error behaviour

A non-2xx API response raises an n8n `NodeOperationError` built only from the API error body
(FR-14.5):

```
Inheco TEC API <status> <kind>: <message>[; firmware code <code> (<code description>)][; transport failure <failure>]
```

A request that gets no API response raises:

```
Inheco TEC API request failed (<reason>): <message>
```

where `<reason>` is one of `invalid_credentials`, `invalid_timeout`, `request_failed`, `timeout`,
`response_too_large` or `invalid_json`. A bad parameter raises `Inheco TEC parameter error: ...`.

Typical kinds:

| HTTP | Kind | Workflow action |
|---|---|---|
| 409 | `stop_not_delivered` | The message starts "Stop was NOT delivered" (or "Emergency-off was NOT delivered"). The stop did not reach the device: the slot may still heat or cool. See the safety section. |
| 409 | `controller_released` | The controller is released to another program (VENUS). Only Stop, Stop All and Emergency Off are allowed. |
| 409 | `emergency_off_active` | Set target / start refused after Emergency Off. See [Emergency Off recovery](#emergency-off-recovery). |
| 503 | `controller_busy` | The controller is busy (a `Retry-After` header is sent). Retry the request, especially a stop. |
| 503 | `controller_not_connected` | Run Connect. |

## Safety: stop operations and Continue On Fail

Stop Temperature Control, Stop All and Emergency Off are **safety operations**. Treat every result
that is not a clear success as "the heater or cooler may still be on".

- **Do not enable "Continue On Fail" (On Error: Continue) on a Stop, Stop All or Emergency Off
  node unless the workflow checks `json.error` right after it.** With Continue On Fail, a failed
  stop — including a 409 "NOT delivered" — does not stop the workflow. It becomes a normal output
  item `{ "error": "<message>" }`, and the next node runs as if the stop worked. The slot can stay
  on. If you need Continue On Fail, put an IF node directly after the stop that routes every item
  with a non-empty `json.error` to an alert / retry / Stop and Error branch.
- **A network failure or a timeout on a stop means the delivery is unknown.** The errors
  `Inheco TEC API request failed (request_failed)` and `(timeout)` mean the node got no answer: the
  stop may or may not have reached the device. Retry the stop, then confirm with Get Status.
- A 502 or 504 on a stop (firmware rejection, no reply, CRC or parse failure, or device lost) also
  leaves the slot state unknown or not stopped. Do not read it as "stopped".
- Retry a stop or Emergency Off on `503 controller_busy`.
- For Stop All, check every entry in `outcomes`; `skipped` and `failed` slots were not stopped by
  this call.

## Emergency Off recovery

Emergency Off switches off **all slot power outputs** of one controller. The `confirm` parameter
must be `true`; the default `false` is refused by the API with HTTP 422 and nothing is sent to the
device (FR-14.7, FR-17.2).

After a successful Emergency Off, the controller is "emergency-off active": Set Target Temperature
and Start Temperature Control are refused with `409 emergency_off_active`; reads, stops and status
stay allowed. The TEC controller does not accept the re-initialize until it is power-cycled. Use
this one procedure in every case (details: section 5.11 "Emergency Off recovery" of the paired API
README,
[`inheco-tec-api`](https://github.com/jamie-zaikov/inheco-tec-api#511-emergency-off-recovery)):

1. **Release Controller if connected, power-cycle, then Reacquire Controller.** (1) If the
   controller is `connected`, run Release Controller; it is allowed while emergency-off is active.
   (2) Power-cycle the TEC controller (the service can keep running). (3) Then run
   Reacquire Controller. Success: the response shows `emergency_off_cleared: true` and
   `stopped_slots` lists every configured slot.
2. **A 502 with firmware code `I` means the power cycle is missing.** If Reacquire Controller
   fails with HTTP 502 `stop_all_failed` and firmware code `I` on the slots,
   the power cycle is missing. Emergency-off stays active and the controller stays `released`.
   Power-cycle the TEC controller, then run Reacquire Controller again.
3. **Connect on a `connected` controller after a power cycle is not the documented path.** The
   service keeps the old device handle, which is likely dead after the power cycle, so the call
   fails closed and emergency-off stays active. Run Release Controller first (point 1).
4. **A service restart is not a recovery step.**
   A service restart clears the emergency-off flag (FR-17.9; the flag is not persisted) but does not recover the device.

After recovery, set the target and start temperature control again; nothing restarts by itself.

## Poll pattern (wait for a temperature)

The node returns immediately, so a workflow waits for a temperature with an n8n loop (FR-14.4):

```
Set Target Temperature
  -> Start Temperature Control
  -> loop:
       Check At Target
         -> IF json.at_target is true (optionally N consecutive times) -> continue the process
         -> else: IF the iteration cap is not reached -> Wait (for example 30 s) -> back to Check At Target
                  else (cap reached)                  -> Stop Temperature Control -> Stop and Error
```

Rules for the loop:

- **Always cap the iterations.** Without a cap, a slot that never reaches the target (wrong target,
  a lid open, a fault) loops forever. In n8n, `{{ $runIndex }}` inside a node in the loop counts how
  often that node ran in this execution; compare it with a fixed cap (for example 40 iterations x
  30 s = 20 minutes).
- **Stability.** Check At Target is one reading. If the process needs a stable temperature, require
  N consecutive `at_target: true` results (for example count them in a Code node, or loop back
  through Wait until N passes in a row) before you continue.
- **Wait interval.** 30 s is a sensible default. Do not poll faster than a few seconds: every poll
  takes the controller lock.
- **On the cap branch, stop the slot** and fail the execution so the operator sees it. Do not set
  Continue On Fail on that stop (see the safety section).

### Example workflow

[`examples/chill-and-wait.workflow.json`](examples/chill-and-wait.workflow.json) implements the
pattern for controller 0, slot 1, target 4 °C, Wait 30 s and a cap of 40 checks:

Manual Trigger -> Set Target Temperature -> Start Temperature Control -> Check At Target ->
At Target? (true -> Target Reached; false -> Below Iteration Cap? (true -> Wait 30 s -> Check At
Target; false -> Stop Temperature Control -> Stop and Error)).

To use it:

1. In n8n, import the file (Workflows -> Import from File).
2. Create an `inhecoTecApi` credential as described in [Credential setup](#credential-setup).
   The file references a credential named `inheco-tec-lab` with a placeholder id; select your own
   credential on each Inheco TEC node.
3. Change the controller, slot, target, wait interval and cap to suit the process. Replace the
   "Target Reached" node with the next step of the process.

The file holds no credential value, no host and no certificate.

## Placeholders

The examples in this README and the files of this repository use the placeholder values below.
Replace each one with the value of your installation. The names in angle brackets inside the
base URL and the error formats (for example the host in the base URL, or the status and the
message of an error) stand for the values of a real installation or request.

<!-- placeholders:begin -->
| Placeholder | Meaning | Example |
|---|---|---|
| `203.0.113.5` | Test address of a remote device in the transport tests. | 203.0.113.50 |
| `api-host.example.com` | DNS name of the instrument API host. | instrument-pc.lab.example |
| `user-pw-xyz@tec.example` | Neutral test-fixture user identity in the node tests (not a real account). | test-user@lab.example |
| `<private-doc-ref>` | Reference to a private document of your organization. | your site runbook |
| `<vendored-node-core>` | The vendored n8n-node-core TypeScript sources and their tests inside the node repository. | src/vendor/n8n-node-core |
| `the API host` | The Windows PC that runs the instrument API (prose form). | the instrument PC next to the device |
| `<reason>` | Failure reason in the error of a node request that got no API response. | timeout |
<!-- placeholders:end -->

## License

MIT; see [LICENSE](LICENSE). The vendored node base under `src/vendor/n8n-node-core/` is part of
this repository and has the same license.

## Paired API

This node and the REST service
[`inheco-tec-api`](https://github.com/jamie-zaikov/inheco-tec-api) are one `inheco-tec` pair: the
API is a host-resident FastAPI service that drives the Inheco TEC controllers attached to the STAR
PC over USB HID, and this node calls it from n8n workflows. They change, version, and ship
together. In the source project they lived side by side as `api/` and `node/` next to the manifest
`instrument.yaml`.

- [`inheco-tec-api`](https://github.com/jamie-zaikov/inheco-tec-api) — the REST service
  `inheco-tec-api`, built on `instrument-api-core` (vendored in that repository). It runs on the
  instrument host as a Windows service (api-hosting sub-pattern 3, host-resident); it is not a
  cloud deployable and needs no Terraform.
- This repository — the n8n community node `n8n-nodes-inheco-tec`, built on `n8n-node-core`
  (vendored). It reaches the api only over HTTP(S), never by code import.
- `instrument.yaml` — the executable manifest (host/IP, port, protocol, auth, controllers and
  slots, limits, capabilities, refs). It ships in the paired API repository, which reads it.
