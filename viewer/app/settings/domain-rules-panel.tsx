"use client"

import { useCallback, useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EmptyState, Field, FieldGroup, ListRow, ProjectLoader, SettingsSection } from "@/components/blocks"
import { LoadFailure } from "../load-failure"
import { failureMessage } from "../api-client"
import { useCurrentUser } from "../use-current-user"
import { isInstanceRole, type InstanceRole } from "../instance-role"

/**
 * Local wire shape for `GET /api/v1/instance/domain-rules` — same convention
 * as `members-panel.tsx`: server-only code isn't reachable from app code via
 * the `@/*` alias. `InstanceRole` itself is the one shared app-side copy
 * (`../instance-role.ts`), not a local redeclaration.
 */
interface DomainRuleView {
  domain: string
  role: InstanceRole
  createdByUserId: string | null
  createdAt: string
}

function isDomainRuleView(v: unknown): v is DomainRuleView {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.domain === "string" && isInstanceRole(r.role)
}

/**
 * Domain rules panel (viewer-membership Task 8): anyone signing in with an
 * email at a listed domain joins automatically, at the listed role, no
 * invite needed. Admin-only — see `MembersPanel`'s doc comment for why the
 * `role !== "admin"` check here is a UX courtesy and not the real gate.
 */
export function DomainRulesPanel() {
  const { user, loading } = useCurrentUser()
  if (loading || user?.role !== "admin") return null
  return <SignedInDomainRulesPanel />
}

function SignedInDomainRulesPanel() {
  const [rules, setRules] = useState<DomainRuleView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [domain, setDomain] = useState("")
  const [role, setRole] = useState<InstanceRole>("viewer")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [removingDomain, setRemovingDomain] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/instance/domain-rules")
      if (!res.ok) throw new Error(`GET domain-rules ${res.status}`)
      const data = (await res.json()) as { domainRules?: unknown }
      const list = Array.isArray(data.domainRules) ? data.domainRules.filter(isDomainRuleView) : []
      setRules(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleAdd = useCallback(async () => {
    const value = domain.trim().toLowerCase()
    if (!value || adding) return
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch(`/api/v1/instance/domain-rules/${encodeURIComponent(value)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setAddError(body?.error ?? "Couldn't add that rule. Try again.")
        return
      }
      setDomain("")
      setAddOpen(false)
      await load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }, [domain, role, adding, load])

  const handleRemove = useCallback(
    async (ruleDomain: string) => {
      setRemovingDomain(ruleDomain)
      setLoadError(null)
      try {
        const res = await fetch(`/api/v1/instance/domain-rules/${encodeURIComponent(ruleDomain)}`, {
          method: "DELETE",
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setLoadError(body?.error ?? "Couldn't remove that rule. Try again.")
          return
        }
        await load()
      } catch (err) {
        setLoadError(failureMessage(err))
      } finally {
        setRemovingDomain(null)
      }
    },
    [load],
  )

  return (
    <>
      <SettingsSection
        frame="bare"
        title="Domain rules"
        description="Anyone who signs in with an email at one of these domains joins automatically, no invite needed."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              // A previous attempt's error must not greet the next one.
              setAddError(null)
              setAddOpen(true)
            }}
            data-testid="domain-rule-add-open"
          >
            Add rule
          </Button>
        }
        data-testid="settings-section-domain-rules"
      >
        {loadError && rules === null ? (
          <LoadFailure size="sm" title="Couldn't load domain rules" description={loadError} />
        ) : rules === null ? (
          <ProjectLoader size={80} label="Loading" className="py-6" />
        ) : rules.length === 0 ? (
          <EmptyState
            size="sm"
            title="No domain rules"
            description="A domain rule lets everyone with an email at that domain join on their own, at a role you pick."
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAddError(null)
                setAddOpen(true)
              }}
            >
              <Plus data-icon="inline-start" />
              Add domain rule
            </Button>
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {rules.map((r) => (
              <li key={r.domain}>
                {/* asChild → a div, not ListRow's default <button>: the row
                    contains its own Remove button — same fix as
                    project-access.tsx / tokens-panel.tsx / members-panel.tsx. */}
                <ListRow asChild density="dense">
                  <div className="group flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      Anyone who signs in with a {r.domain} address joins as {r.role}.
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="flex-none opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={`Remove rule for ${r.domain}`}
                      disabled={removingDomain === r.domain}
                      onClick={() => void handleRemove(r.domain)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </ListRow>
              </li>
            ))}
          </ul>
        )}

        {loadError && rules !== null ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : null}
      </SettingsSection>

      {/*
        Creation is its own surface, not a form under the list (Mo, 2026-08-21
        for tokens, applied here 2026-08-26). A list answers "what is set up";
        a form answers "add one". Sharing a panel makes the empty state read
        as a caption for the form beneath it, and leaves a permanent
        half-filled form on screen for everyone who came only to read.

        See docs/design.md § "A list and its create form are not the same
        surface".
      */}
      <Dialog open={addOpen} onOpenChange={(next) => !adding && setAddOpen(next)}>
        {/* No `X` while the add is in flight. Mo, 2026-08-28. */}
        <DialogContent size="md" showCloseButton={!adding}>
          <DialogHeader>
            <DialogTitle>Add a domain rule</DialogTitle>
            <DialogCopy
              description="Everyone who signs in with an email at this domain joins automatically, at the role you pick."
              {...(addError ? { issues: [{ key: "add", node: addError }] } : {})}
            />
          </DialogHeader>

          <FieldGroup>
            <Field label="Domain" htmlFor="domain-rule-input">
              <Input
                id="domain-rule-input"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                autoComplete="off"
              />
            </Field>
            <Field label="Role" htmlFor="domain-rule-role">
              <Select value={role} onValueChange={(v) => setRole(v as InstanceRole)}>
                <SelectTrigger id="domain-rule-role" size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddOpen(false)}
              disabled={adding}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!domain.trim() || adding}
              busy={adding}
              onClick={() => void handleAdd()}
              data-testid="domain-rule-add-submit"
            >
              {/* "Add", not "Add rule": the dialog is titled "Add a domain
                  rule". docs/design.md, "Don't repeat the noun the surface
                  already carries". */}
              {adding ? "Adding" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
