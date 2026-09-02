"use client"

/**
 * `BannerToasts` — headless; surfaces the editor's component-edit mode and
 * save-status notices as bottom-right Sonner toasts. No markup of its own.
 *
 * It used to live in `editor-top-bar.tsx` alongside a bar that no longer
 * existed. The two editor chrome surfaces are now `editor-nav-bar.tsx` (the
 * full-width row) and `editor-toolbar.tsx` (the floating pill); the toasts
 * belong to neither, so they get their own file.
 */

import * as React from "react"
import { toast } from "sonner"
import type { useEditorEditing } from "@/hooks/useEditorEditing"

type EditingApi = ReturnType<typeof useEditorEditing>

interface BannersProps {
  editing: EditingApi
}

const COMPONENT_EDIT_TOAST = "editor-component-edit"
const EDITOR_STATUS_TOAST = "editor-status"

/**
 * Headless: surfaces the editor's status notices as bottom-right Sonner
 * toasts. The persistent component-edit-mode toast uses `duration: Infinity`
 * and is dismissed by id when the condition clears; the transient save-status
 * auto-dismisses.
 */
export function BannerToasts({ editing }: BannersProps) {
  // Component-edit mode (persistent while editing a subcomponent).
  const editState = editing.componentEditState
  const { handleExitComponentEdit } = editing
  React.useEffect(() => {
    if (!editState) {
      toast.dismiss(COMPONENT_EDIT_TOAST)
      return
    }
    /*
     * No close button on this one (Mo, 2026-08-18: "not sure why there is an
     * exit button here… if it is to close the toast it isn't necessary").
     *
     * The X and the Exit action did different things and looked like
     * alternatives: X hid the toast while component-edit mode stayed ON,
     * leaving the user in a mode with no indicator and no way out. This is a
     * STATE indicator, not a notice, so the only control on it is the one
     * that changes the state.
     */
    toast.info(`Editing ${editState.componentName}`, {
      id: COMPONENT_EDIT_TOAST,
      duration: Infinity,
      closeButton: false,
      action: { label: "Exit", onClick: () => handleExitComponentEdit() },
    })
    return () => { toast.dismiss(COMPONENT_EDIT_TOAST) }
  }, [editState, handleExitComponentEdit])

  // Transient save status.
  React.useEffect(() => {
    if (editing.saveStatus && !editing.saving) {
      toast(editing.saveStatus, { id: EDITOR_STATUS_TOAST })
    }
  }, [editing.saveStatus, editing.saving])

  return null
}
