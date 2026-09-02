"use client"

import { useCallback, useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, ProjectLoader, SettingsSection } from "@/components/blocks"
import { Switch } from "@/components/ui/switch"
import { LoadFailure } from "../load-failure"
import { failureMessage } from "../api-client"
import { useCurrentUser } from "../use-current-user"

/**
 * Instance settings panel (viewer-membership Task 8). One setting today:
 * whether a project may ever be reached without signing in. Admin-only —
 * see `MembersPanel`'s doc comment for why the `role !== "admin"` check
 * here is a UX courtesy and not the real gate.
 *
 * The switch is LIVE: it reads and writes the real
 * `/api/v1/instance/settings` row, and (as of Task 10) that value is what
 * `authorize.ts`'s read policy actually checks (`project.access ===
 * "public-link" && policy.allowPublicLinks`) — turning it off makes every
 * `public-link` project require sign-in immediately, the same instant a
 * signed-in caller flips it, with nothing to restart.
 */
export function InstanceSettingsPanel() {
  const { user, loading } = useCurrentUser()
  if (loading || user?.role !== "admin") return null
  return <SignedInInstanceSettingsPanel />
}

function SignedInInstanceSettingsPanel() {
  const [allowPublicLinks, setAllowPublicLinks] = useState<boolean | null>(null)
  const [allowAnonymousComments, setAllowAnonymousComments] = useState<boolean | null>(null)
  const [email, setEmail] = useState<EmailSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/instance/settings")
      if (!res.ok) throw new Error(`GET instance settings ${res.status}`)
      const data = (await res.json()) as {
        allowPublicLinks?: unknown
        allowAnonymousComments?: unknown
        email?: unknown
      }
      // Both default to `true` on an unrecognized value, matching the server's
      // absent-means-default decoding. See `instance-settings.ts`.
      setAllowPublicLinks(typeof data.allowPublicLinks === "boolean" ? data.allowPublicLinks : true)
      setAllowAnonymousComments(
        typeof data.allowAnonymousComments === "boolean" ? data.allowAnonymousComments : true,
      )
      setEmail(isEmailSettingsView(data.email) ? data.email : null)
      setLoadError(null)
    } catch (err) {
      setLoadError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * One save path for every switch in this panel, keyed by the field name the
   * API uses. Written generically rather than once per setting: the rollback,
   * the error surfacing and the saving flag are the whole body, and a second
   * near-copy of them is how two switches end up behaving differently on
   * failure.
   */
  const handleToggle = useCallback(
    async (
      field: "allowPublicLinks" | "allowAnonymousComments",
      next: boolean,
      previous: boolean | null,
      apply: (value: boolean | null) => void,
    ) => {
      apply(next)
      setSaving(true)
      setSaveError(null)
      try {
        const res = await fetch("/api/v1/instance/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: next }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setSaveError(body?.error ?? "Couldn't save that setting. Try again.")
          // Roll back to what the server actually has — an optimistic flip
          // that silently stuck on failure would show an admin a switch
          // position the server never recorded.
          apply(previous)
          return
        }
      } catch (err) {
        setSaveError(failureMessage(err))
        apply(previous)
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  return (
    <SettingsSection
      frame="bare"
      title="Viewer settings"
      description="Settings that apply to this whole viewer, not to one project."
    >
      {loadError && allowPublicLinks === null ? (
        <LoadFailure size="sm" title="Couldn't load viewer settings" description={loadError} />
      ) : allowPublicLinks === null ? (
        <ProjectLoader size={80} label="Loading" className="py-6" />
      ) : (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="allow-public-links" className="text-sm">
              Allow public links
            </Label>
            <p className="text-xs text-muted-foreground">
              Projects can be shared by public link. Turn this off to require sign-in for every project.
            </p>
          </div>
          <Switch
            id="allow-public-links"
            checked={allowPublicLinks}
            disabled={saving}
            onCheckedChange={(checked) =>
              void handleToggle("allowPublicLinks", checked, allowPublicLinks, setAllowPublicLinks)
            }
          />
        </div>
      )}

      {allowAnonymousComments === null ? null : (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="allow-anonymous-comments" className="text-sm">
              Allow comments without signing in
            </Label>
            <p className="text-xs text-muted-foreground">
              Anyone who can open a project can comment on it. Turn this off to require sign-in,
              so visitors can still read the conversation but not add to it.
            </p>
          </div>
          <Switch
            id="allow-anonymous-comments"
            checked={allowAnonymousComments}
            disabled={saving}
            onCheckedChange={(checked) =>
              void handleToggle(
                "allowAnonymousComments",
                checked,
                allowAnonymousComments,
                setAllowAnonymousComments,
              )
            }
          />
        </div>
      )}

      {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}

      {/*
        Mail is EDITABLE here now (Mo, 2026-08-26: "they should not be sent to
        any settings config, this should be editable in the GUI"). It used to
        be a read-only status line pointing at four environment variables.

        The env still wins, so when a deployment sets `VIEWER_SMTP_HOST` this
        shows the settings and says they are not editable here, rather than
        offering a form whose save the server would refuse. Accepting an edit
        that silently does not apply is the worse failure.
      */}
      {email !== null ? <MailSettings email={email} onChanged={setEmail} /> : null}
    </SettingsSection>
  )
}

/** What `GET /api/v1/instance/settings` reports about mail. Never a password. */
export interface EmailSettingsView {
  configured: boolean
  source: "env" | "stored" | null
  host: string | null
  port: number | null
  user: string | null
  from: string | null
  hasPassword: boolean
}

function isEmailSettingsView(v: unknown): v is EmailSettingsView {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.configured === "boolean" && typeof r.hasPassword === "boolean"
}

/**
 * Mention and sign-in mail, set from here.
 *
 * ## The password field is write-only
 *
 * The server never returns it, so this cannot show it. Leaving the field
 * blank keeps whatever is stored — if blank meant "clear", editing the From
 * address would wipe the credential every time. The placeholder says which
 * of the two states it is in, because an empty box that means "unchanged"
 * and an empty box that means "none yet" look identical.
 *
 * ## Read-only when the environment sets it
 *
 * `source === "env"` means `VIEWER_SMTP_HOST` is set and `loadConfig` ignores
 * anything stored, so the form is shown filled and disabled rather than
 * offering a save the server would refuse with a 409.
 */
function MailSettings({
  email,
  onChanged,
}: {
  email: EmailSettingsView
  onChanged: (next: EmailSettingsView) => void
}) {
  const fromEnv = email.source === "env"
  const [host, setHost] = useState(email.host ?? "")
  const [port, setPort] = useState(String(email.port ?? 587))
  const [user, setUser] = useState(email.user ?? "")
  const [from, setFrom] = useState(email.from ?? "")
  const [pass, setPass] = useState("")
  // Whether the password field is unlocked for typing. Starts locked (the
  // eight-char mask) whenever a password is already stored.
  const [editingPass, setEditingPass] = useState(!email.hasPassword)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/instance/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port: Number(port), user, pass, from }),
      })
      const body = (await res.json().catch(() => null)) as
        | (EmailSettingsView & { error?: string })
        | null
      if (!res.ok) {
        setError(body?.error ?? "Couldn't save the mail settings. Try again.")
        return
      }
      if (body) {
        onChanged(body)
        // Re-lock the field behind the mask once a password is stored.
        setEditingPass(!body.hasPassword)
      }
      // Never keep a credential in component state longer than the request
      // that carried it.
      setPass("")
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setSaving(false)
    }
  }, [host, port, user, pass, from, onChanged])

  const turnOff = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/instance/email", { method: "DELETE" })
      const body = (await res.json().catch(() => null)) as
        | (EmailSettingsView & { error?: string })
        | null
      if (!res.ok) {
        setError(body?.error ?? "Couldn't turn mail off. Try again.")
        return
      }
      if (body) onChanged(body)
      setHost("")
      setUser("")
      setFrom("")
      setPass("")
      setEditingPass(true)
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setSaving(false)
    }
  }, [onChanged])

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      {/* "Email server", not "Mention emails" (Mo, 2026-08-31): the block IS
          the server settings, and mentions are one of the things sent through
          it. The purpose leads; the state follows. */}
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">Email server</p>
        <p className="text-xs text-muted-foreground">
          Used to send comment mentions, sign-in links, and other notification emails.{" "}
          {fromEnv ? (
            <>
              Sending from {email.from}. The server is set in the environment, so it can&apos;t be
              changed here.{" "}
            </>
          ) : email.configured ? (
            <>Sending from {email.from}.{" "}</>
          ) : null}
          <a
            href="https://desde.design/docs/self-hosting/email"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:no-underline"
            data-testid="email-setup-docs-link"
          >
            How to set up an email server
          </a>
        </p>
      </div>

      <FieldGroup>
        <Field label="Server" htmlFor="smtp-host">
          <Input
            id="smtp-host"
            value={host}
            disabled={fromEnv || saving}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            autoComplete="off"
          />
        </Field>
        <Field label="Port" htmlFor="smtp-port">
          <Input
            id="smtp-port"
            value={port}
            disabled={fromEnv || saving}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            className="w-28"
          />
        </Field>
        <Field label="Username" htmlFor="smtp-user">
          <Input
            id="smtp-user"
            value={user}
            disabled={fromEnv || saving}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="off"
          />
        </Field>
        {/* A saved password shows as a fixed mask with a Reset beside it (Mo,
            2026-08-31) — an editable-but-empty box labelled "Unchanged" made
            the stored credential look absent. The mask is a constant eight
            characters; the server never returns the real one, so there is no
            length to leak. Reset only unlocks the field: saving it blank
            still keeps the stored password (the PUT treats blank as
            "unchanged"), and the hint says so. */}
        <Field
          label="Password"
          htmlFor="smtp-pass"
          hint={
            editingPass
              ? email.hasPassword
                ? "Leave blank to keep the saved password."
                : "Stored on this server, and never shown again."
              : undefined
          }
        >
          {editingPass ? (
            <Input
              id="smtp-pass"
              type="password"
              value={pass}
              disabled={fromEnv || saving}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="new-password"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <Input id="smtp-pass" readOnly value="********" className="flex-1" />
              {fromEnv ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setPass("")
                    setEditingPass(true)
                  }}
                >
                  Reset password
                </Button>
              )}
            </div>
          )}
        </Field>
        <Field label="From address" htmlFor="smtp-from">
          <Input
            id="smtp-from"
            value={from}
            disabled={fromEnv || saving}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="reviews@example.com"
            autoComplete="off"
          />
        </Field>
      </FieldGroup>

      {error ? (
        <p role="status" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {fromEnv ? null : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={saving} busy={saving}>
            {saving ? "Saving" : "Save"}
          </Button>
          {email.configured ? (
            <Button size="sm" variant="ghost" onClick={() => void turnOff()} disabled={saving}>
              Turn off
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
