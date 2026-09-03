// @vitest-environment jsdom
/**
 * React 19 renders `<html>`, `<head>` and `<body>` as HostSingleton fibers
 * (tag 27) and `<title>` / `<link>` / `<meta>` as HostHoistable (tag 26)
 * when an app renders into `document`, which is what React Router
 * framework mode and Remix do. Neither is tag 5, so a walk that recognised
 * only HostComponent called the first inner `<div>` the layout's mount root
 * and climbed straight through `<body>` and `<html>` (adversarial review,
 * 2026-09-02). Its own file: rendering into `document` replaces the
 * document's `<html>` for the rest of the file.
 */
import { describe, it, expect } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import {
  buildReactComponentTree,
  detectOutlineComponent,
  detectReactOutlineComponent,
  getReactFiberOf,
} from "./framework-component-detection"
import { generateSelector } from "./selector-engine"

describe("React mount roots with singleton and hoistable hosts", () => {
  it("a layout rendering <html> mounts as <html>; <body> is nobody's root; the walk stops at singleton hosts", () => {
    function Shell() {
      return <div className="shell">shell</div>
    }
    function RootLayout() {
      return (
        <html lang="en">
          <head>
            <title>Northwind</title>
          </head>
          <body>
            <div className="root">
              <Shell />
            </div>
          </body>
        </html>
      )
    }
    function App() {
      return <RootLayout />
    }
    const root = createRoot(document)
    act(() => {
      root.render(<App />)
    })

    const html = document.documentElement
    const body = document.body
    const rootDiv = document.querySelector(".root")!
    const shell = document.querySelector(".shell")!
    const title = document.querySelector("title")!

    // Real tags, so the test fails loudly if React changes them.
    expect(getReactFiberOf(html)?.tag).toBe(27)
    expect(getReactFiberOf(body)?.tag).toBe(27)
    expect(getReactFiberOf(title)?.tag).toBe(26)

    // App renders only RootLayout, so both are rooted at <html>; outermost wins.
    expect(detectOutlineComponent(html)?.name).toBe("App")
    expect(detectOutlineComponent(body)).toBeNull()
    expect(detectOutlineComponent(rootDiv)).toBeNull()
    expect(detectReactOutlineComponent(shell)?.name).toBe("Shell")

    const tree = buildReactComponentTree(shell)
    expect(tree.map((n) => n.name)).toEqual(["App", "RootLayout", "Shell"])
    expect(tree[0].elementSelector).toBe(generateSelector(html))
    expect(tree[1].elementSelector).toBe(generateSelector(html))
    expect(tree[2].elementSelector).toBe(generateSelector(shell))

    act(() => {
      root.unmount()
    })
  })
})
