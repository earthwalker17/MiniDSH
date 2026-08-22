/**
 * Read-before-edit policy. An event-only plugin (no service): it records every
 * `fs/observed` per session and answers `fs/edit-intent` with the observed
 * version (the CAS token) or refuses an edit of a file never read. Without it,
 * edits are unconditional.
 */
import type { Plugin } from '../../kernel/index.ts'
import { FS_EDIT_INTENT, FS_OBSERVED, FsError, type FsActor, type FsObservation, type FsTarget } from '../../core/fs/index.ts'
import type { Session } from '../../core/session/index.ts'

export const fsObservationPolicyPlugin: Plugin = {
  name: 'fs-observation-policy',
  apply(ctx) {
    const observations = new WeakMap<Session, Map<string, FsObservation>>()

    const bySession = (actor: FsActor): Map<string, FsObservation> | undefined => {
      const session = actor.agent?.session
      if (!session) return undefined
      let map = observations.get(session)
      if (!map) {
        map = new Map()
        observations.set(session, map)
      }
      return map
    }

    ctx.on(FS_OBSERVED, (target: FsTarget, observation: FsObservation, actor: FsActor) => {
      bySession(actor)?.set(target.path, observation)
    })

    ctx.on(FS_EDIT_INTENT, (target: FsTarget, actor: FsActor): FsObservation => {
      const observed = bySession(actor)?.get(target.path)
      if (!observed) throw new FsError('FS_NOT_OBSERVED', `edit requires reading "${target.displayPath}" first`)
      if (observed.kind === 'absent') throw new FsError('FS_NOT_FOUND', `"${target.displayPath}" was observed absent`)
      return observed
    })
  },
}
