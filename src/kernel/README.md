# src/kernel

The kernel is the composition substrate under everything else: contexts, plugins, a service store and an event bus. It knows no service, event or plugin by name. It imports nothing from the rest of `src/`. Every other layer may import it, and each does so only through `index.ts`. [ARCHITECTURE §1](../../docs/ARCHITECTURE.md#1-layers-and-dependency-direction) states the rule. [`scripts/check-deps.ts`](../../scripts/check-deps.ts) enforces it inside `pnpm check`: a kernel import that leaves `src/kernel` fails, and so does an `import()` whose target is not a string literal.

## Start here

- [`index.ts`](index.ts): the whole public surface on one screen.
- [`tokens.ts`](tokens.ts): how a service and an event are addressed, and why an event's dispatch mode is part of its type.
- [`context.ts`](context.ts): everything else. Read the file header, then the method names of `Context`.

## Reading order

1. `index.ts`. What does the kernel export?
2. `tokens.ts`. What are a `ServiceKey` and an `EventKey`, and which dispatch modes exist?
3. `errors.ts`. What can the kernel refuse? `KernelErrorCode` is the list.
4. `bus.ts`. Which listeners does a dispatch reach (`select`), and what runs before them (`preflight`)?
5. `context.ts`, `EffectList`. Who owns a registration, and in what order is it undone?
6. `context.ts`, `PluginInstance`. When does a plugin load, unload and reload? `refresh` is the one mechanism.
7. `context.ts`, `Context`. How is a service provided and read, how is a scope derived (`child`), and how does each of `emit`, `waterfall`, `serial` and `parallel` deliver?
8. [`kernel.test.ts`](kernel.test.ts). Which behaviours are pinned? The `describe` titles are the list.

## Modules

The kernel has no subdirectories, so the rows are its files. The DSH comparison covers the layer as a whole. It was not mapped file by file.

| Module | Owns | DSH counterpart | Where MiniDSH differs |
|---|---|---|---|
| `index.ts` | the export surface, the only kernel path other layers import | Cordis, as upstream's `docs/architecture.md` describes it | MiniDSH has its own small kernel with only the mechanisms §2 lists. It does not use Cordis, on which upstream composes many plugin packages. See [§12](../../docs/ARCHITECTURE.md#12-divergences-from-deepseek-harness-the-ones-that-still-shape-decisions). |
| `tokens.ts` | typed service and event tokens. An event token carries its dispatch mode | none mapped | Not compared. MiniDSH uses no declaration merging. |
| `bus.ts` | listener storage, the scope admission rule, pre-delivery observers | none mapped | Not compared. |
| `context.ts` | `Context`: services in realms, plugins and scopes as effect owners, activation from declared dependencies, the dispatch methods, `settle` | none mapped | Not compared. |
| `errors.ts` | `KernelError` and its closed code set | none mapped | Not compared. |

## The contract

- [§2 Kernel (`src/kernel`)](../../docs/ARCHITECTURE.md#2-kernel-srckernel) holds the kernel's invariants and the scope contract built on them. [§1 Layers and dependency direction](../../docs/ARCHITECTURE.md#1-layers-and-dependency-direction) holds the import rule.
- `kernel.test.ts` tests the mechanisms. [`../core/scope.test.ts`](../core/scope.test.ts) tests the scope contract through real registries. [`scripts/check-deps.test.ts`](../../scripts/check-deps.test.ts) tests the gate's rules on synthetic trees.
- [§11 Where new things go](../../docs/ARCHITECTURE.md#11-where-new-things-go) has no row for a new kernel mechanism. Its last line says what that means: an architecture question comes first.
