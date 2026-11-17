import { array, number, object, text } from './data.ts'

export interface Repository {
  id: number
  full_name: string
}
export interface PullRequest {
  number: number
  state: string
  head: { sha: string; ref: string; repo: Repository }
  base: { sha: string; ref: string; repo: Repository }
}
export interface Run {
  id: number
  run_attempt: number
  event: string
  workflow_id: number
  path: string
  status: string
  conclusion: string | null
  display_title: string
  head_sha: string
  head_branch: string
  head_repository: Repository | null
  repository: { full_name: string }
  pull_requests: { number: number }[]
}
export interface Comment {
  id: number
  user: { login: string; type: string }
  body: string
}
export interface Artifact {
  id: number
  name: string
  expired: boolean
  size_in_bytes: number
}

function repository(value: unknown): Repository {
  const raw = object(value)

  return { id: number(raw.id), full_name: text(raw.full_name) }
}

export function pullRequest(value: unknown): PullRequest {
  const raw = object(value)
  const head = object(raw.head)
  const base = object(raw.base)

  return {
    number: number(raw.number),
    state: text(raw.state),
    head: { sha: text(head.sha), ref: text(head.ref), repo: repository(head.repo) },
    base: { sha: text(base.sha), ref: text(base.ref), repo: repository(base.repo) },
  }
}

export function candidates(value: unknown): { number: number }[] {
  return array(value).map((entry) => ({ number: number(object(entry).number) }))
}

/** Decode only fields used for identity/freshness; unrelated REST fields remain irrelevant. */
export function workflowRun(value: unknown): Run {
  const raw = object(value)

  return {
    id: number(raw.id),
    run_attempt: number(raw.run_attempt),
    event: text(raw.event),
    workflow_id: number(raw.workflow_id),
    path: text(raw.path),
    status: text(raw.status),
    conclusion: raw.conclusion === null ? null : text(raw.conclusion),
    display_title: text(raw.display_title),
    head_sha: text(raw.head_sha),
    head_branch: text(raw.head_branch),
    head_repository: raw.head_repository == null ? null : repository(raw.head_repository),
    repository: { full_name: text(object(raw.repository).full_name) },
    pull_requests: raw.pull_requests == null ? [] : candidates(raw.pull_requests),
  }
}

export function comments(value: unknown): Comment[] {
  return array(value).map((entry) => {
    const raw = object(entry)
    const user = object(raw.user)

    return {
      id: number(raw.id),
      user: { login: text(user.login), type: text(user.type) },
      body: text(raw.body),
    }
  })
}

export function artifacts(value: unknown): Artifact[] {
  return array(object(value).artifacts).map((entry) => {
    const raw = object(entry)

    // A missing/invalid expiry flag must not make an artifact eligible for publication.
    if (typeof raw.expired !== 'boolean') throw new Error('Expected artifact expiry flag')

    return {
      id: number(raw.id),
      name: text(raw.name),
      expired: raw.expired,
      size_in_bytes: number(raw.size_in_bytes),
    }
  })
}
