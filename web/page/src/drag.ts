// A bottom sheet dragged down by a finger (Sheet.tsx): once its rows are
// scrolled to the top, a pull down moves the sheet instead; let go past a
// third of its height or with a flick, it closes, else it goes back.
// app/lib/ui/sheet.dart decides the same.

// Whether a drag let go [dy] px below where the sheet rests, moving at
// [velocity] px/s (downwards positive), closes a sheet [height] px tall.
export function dragCloses(dy: number, velocity: number, height: number): boolean {
  return dy > 0 && (velocity > 700 || (velocity > -300 && dy > height / 3));
}

// How far a finger goes before it counts as a drag, either way.
const slop = 6;

export class SheetDrag {
  private from = 0;
  private state: "idle" | "deciding" | "dragging" = "idle";
  private dy = 0;
  // The last few moves, for the speed at letting go.
  private moves: { y: number; t: number }[] = [];

  // A finger down, with the rows [scrollTop] px down.
  start(y: number, t: number, scrollTop: number): void {
    this.from = y;
    this.dy = 0;
    this.moves = [{ y, t }];
    this.state = scrollTop <= 0 ? "deciding" : "idle";
  }

  // The finger moved: how far below its rest the sheet is now, or undefined
  // when the move is the rows' (a scroll), not the sheet's.
  move(y: number, t: number, scrollTop: number): number | undefined {
    if (this.state === "idle") {
      // Scrolled back to the top on the way: the sheet's from here on.
      if (scrollTop > 0) return undefined;
      this.start(y, t, scrollTop);
      return undefined;
    }
    if (this.state === "deciding") {
      const d = y - this.from;
      if (d < -slop) {
        this.state = "idle";
        return undefined;
      }
      if (d < slop) return undefined;
      this.state = "dragging";
      this.from = y;
    }
    this.dy = Math.max(0, y - this.from);
    this.moves.push({ y, t });
    if (this.moves.length > 5) this.moves.shift();
    return this.dy;
  }

  // Whether the finger is the sheet's now: the browser is then kept from
  // scrolling the rows. Until then they are free to scroll; at the top, a
  // pull down does nothing of theirs (overscroll-none, Sheet.tsx).
  pulling(): boolean {
    return this.state === "dragging";
  }

  // The finger up: whether the sheet closes, goes back, or was never moved.
  end(t: number, height: number): "close" | "back" | undefined {
    const was = this.state;
    this.state = "idle";
    if (was !== "dragging") return undefined;
    const first = this.moves[0];
    const last = this.moves[this.moves.length - 1];
    // A finger that stopped before letting go has no speed.
    const span = t - first.t;
    const velocity = span > 0 && t - last.t < 100 ? ((last.y - first.y) / span) * 1000 : 0;
    return dragCloses(this.dy, velocity, height) ? "close" : "back";
  }
}
