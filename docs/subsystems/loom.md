# Loom

English | [中文](loom.zh.md)

The experimental [Loom service](../../packages/experimental/loom/README.md) treats forked Sessions as a tree. A fork Session copies an exact event prefix of its source and records the source as its parent; Loom reads that tree and adds branch membership as experimental plugin records. The [Loom interface Agent Note](../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md) owns the staged plan.

## Fork families

`LoomFamily` is the fork family of one Session as derived from a Session list: `rootId` names the highest listed fork ancestor, `focusId` the requested Session, and `nodes` every listed fork descendant of the root in depth-first order, siblings in creation order and then by Session id. A `LoomFamilyNode` carries a branded `LoomNodeId` whose text is the Session id, the Session id itself, its parent node, its depth, the creation time from the row's `forkLineage` list hint when present, and the list facts `updatedAt`, `running`, and `blank`. A subagent parent link is not a fork link. The browser derives families from its client Session list through the `@deepseek-ai/dsh-experimental-loom/family` export; the Host `family()` read serves other callers, and `LoomFamilyRequest` names any member of the family.

## Branch membership

`plugin:loom/branch` is a `LoomBranchRecord` that a branch child holds before its first prompt: the `LoomSetId` of its branch request, the source Session and the inclusive source seq it was cut at, its one-based `variant` among `variantCount` children, the `LoomBranchKind`, and optional `variantKey` and `LoomRunId`. The `loomBranch` projection publishes a `LoomBranchView` of `{ inheritedEventCount, branch }`; only a record at or after the Session's inherited event count is membership.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloom--loom"></a>

### `ctx.loom` — `Loom`

Loom Host service. It registers the `loomBranch` projection unit and the telemetry redaction rule for `plugin:loom/*` records for its own lifetime, and exposes the `loom` Remote namespace.

```ts cordis-catalog
/**
 * Read the fork family of one visible Session from the current Session list
 * without activating any Agent. The Gateway authorizes the addressed Session
 * through the `sessionId` field the Session Controller registers as the
 * `session` resource, and the result keeps only Sessions the caller may list.
 * It serves callers without a Session list of their own; the Loom browser
 * plugin derives families from its client Session list instead.
 * @param request - any member of the family.
 * @param signal - cancellation for the list read.
 * @returns the visible family rooted at the highest visible fork ancestor.
 * @throws RemoteError `session/not-found` when the caller cannot list the Session.
 */
@Remote async family(request: LoomFamilyRequest, signal: AbortSignal): Promise<LoomFamily>
```

Source: [`packages/experimental/loom/src/index.ts`](../../packages/experimental/loom/src/index.ts)
<!-- END GENERATED cordis-surface -->
