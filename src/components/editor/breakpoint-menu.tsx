"use client";

/**
 * Responsive-breakpoint control as a compact icon button in the prototype
 * toolbar (sits left of the screenshot capture). Clicking opens a menu of
 * the preview-width options; the active one is checked. Replaces the
 * inline segmented toggle that used to live in the workspace header row.
 */

import { ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SegmentedToggleOption } from "@/components/editor/segmented-toggle";
import type { ActiveBreakpoint } from "@/components/editor/tailwind-classes";

interface BreakpointMenuProps {
  value: ActiveBreakpoint;
  options: ReadonlyArray<SegmentedToggleOption<ActiveBreakpoint>>;
  onChange: (next: ActiveBreakpoint) => void;
}

export function BreakpointMenu({
  value,
  options,
  onChange,
}: BreakpointMenuProps) {
  const activeLabel = options.find((o) => o.value === value)?.label ?? value;
  return (
    // `TooltipProvider` here rather than once at the app root, matching
    // `UndoRedoControls` beside it: `Tooltip` does not self-provide, and a
    // control that only works under a provider someone else remembered to
    // add is a control that breaks when it moves.
    <DropdownMenu>
      {/*
        The shadcn Tooltip, not the native `title` attribute (Mo, 2026-08-18:
        "there is a different hover for items in the toolbar").
        
        `title` renders the OS tooltip — a light grey box, after the browser's
        own ~1s delay, in the platform's font. Undo, Redo and every other
        control in this pill use `Tooltip`, which is dark, immediate and
        themed. Two tooltip systems six pixels apart is one control looking
        like it came from a different application.
      */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Responsive breakpoint"
                data-testid="editor-breakpoint-menu"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Responsive breakpoint: {activeLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="center">
        <DropdownMenuLabel>Breakpoint</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as ActiveBreakpoint)}
        >
          {options.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value}>
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
