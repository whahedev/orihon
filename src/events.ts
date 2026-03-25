interface EventMetadata<TType extends string, TTarget> {
  type: TType;
  target: TTarget;
  sourceTarget: Evented<any>;
  propagatedFrom?: Evented<any>;
  layer?: Evented<any>;
}

/** Flat event object: payload fields live on the event itself (e.g. `event.latlng`). */
export type OrihonEvent<T extends object = Record<string, unknown>, TType extends string = string, TTarget = Evented<any>> =
  T extends unknown
    ? Omit<T, "type" | "target" | "sourceTarget" | "detail"> &
      EventMetadata<TType, TTarget> &
      Record<string, unknown>
    : never;

/** Known literal names infer their payload; dynamic/custom names retain unknown fields. */
export type EventFor<TEvents extends object, TName extends string, TTarget = Evented<any>> =
  string extends TName ? OrihonEvent<Record<string, unknown>, TName, TTarget> : TName extends keyof TEvents
    ? OrihonEvent<TEvents[TName] & object, TName, TTarget>
    : OrihonEvent<Record<string, unknown>, TName, TTarget>;

export type EventHandler<T extends { type: string } = OrihonEvent> = (event: T) => void;

export class Evented<TEvents extends object = {}> {
  readonly #events = new Map<string, Set<EventHandler>>();
  readonly #eventParents = new Set<Evented<any>>();

  on<K extends string>(type: K, handler: EventHandler<EventFor<TEvents, NoInfer<K>, this>>): this {
    const list = this.#events.get(type);
    const normalized = handler as unknown as EventHandler;
    if (list) list.add(normalized);
    else this.#events.set(type, new Set([normalized]));
    return this;
  }

  once<K extends string>(type: K, handler: EventHandler<EventFor<TEvents, NoInfer<K>, this>>): this {
    const wrap: EventHandler<EventFor<TEvents, K, this>> = (event) => {
      this.off(type, wrap);
      handler(event);
    };
    // Remember the caller's function so `off(type, handler)` can cancel a
    // `once` subscription that has not fired yet.
    (wrap as OnceHandler)[ONCE_SOURCE] = handler as unknown as EventHandler;
    return this.on(type, wrap);
  }

  off(): this;
  off<K extends string>(type: K, handler?: EventHandler<EventFor<TEvents, NoInfer<K>, this>>): this;
  off(type?: string, handler?: EventHandler<any>): this {
    if (!type) {
      this.#events.clear();
      return this;
    }
    const list = this.#events.get(type);
    if (!list) return this;
    if (handler) {
      if (!list.delete(handler)) {
        for (const registered of list) {
          if ((registered as OnceHandler)[ONCE_SOURCE] === handler) {
            list.delete(registered);
            break;
          }
        }
      }
    } else list.clear();
    if (!list.size) this.#events.delete(type);
    return this;
  }

  listens(type: string, propagate = false): boolean {
    if (this.#events.get(type)?.size) return true;
    return propagate && [...this.#eventParents].some((parent) => parent.listens(type, true));
  }

  addEventParent(parent: Evented<any>): this {
    if (parent !== this) this.#eventParents.add(parent);
    return this;
  }

  removeEventParent(parent: Evented<any>): this {
    this.#eventParents.delete(parent);
    return this;
  }

  emit<T extends Record<string, unknown> = Record<string, unknown>>(type: string, payload = {} as T, propagate = true): this {
    return this.#dispatch(type, payload, propagate, null);
  }

  #dispatch<T extends Record<string, unknown>>(
    type: string,
    payload: T,
    propagate: boolean,
    visited: Set<Evented<any>> | null
  ): this {
    const list = this.#events.get(type);
    const parents = propagate && this.#eventParents.size ? this.#eventParents : null;
    // Nobody is listening here and nothing to propagate to: skip building the event.
    if (!list?.size && !parents) return this;

    const sourceTarget = payload.sourceTarget instanceof Evented ? payload.sourceTarget : this;
    // Payloads are flat only — strip any accidental `detail` while copying rather
    // than `delete`-ing it afterwards, which would deoptimize the event object.
    const { detail: _detail, ...rest } = payload as T & { detail?: unknown };
    const event = { ...rest, type, target: this, sourceTarget } as unknown as OrihonEvent<T>;

    if (list?.size) {
      for (const handler of [...list]) {
        try {
          handler(event);
        } catch (error) {
          // A single broken listener must not abort the remaining handlers —
          // `emit` runs inside the render loop. The error still surfaces.
          reportHandlerError(error);
        }
      }
    }

    if (parents) {
      const seen = visited ?? new Set<Evented<any>>();
      seen.add(this);
      const layer = payload.layer instanceof Evented ? payload.layer : this;
      for (const parent of parents) {
        if (seen.has(parent)) continue;
        parent.#dispatch(type, { ...rest, sourceTarget, propagatedFrom: this, layer }, true, seen);
      }
    }
    return this;
  }
}

const ONCE_SOURCE = Symbol("orihon.once");

type OnceHandler = EventHandler & { [ONCE_SOURCE]?: EventHandler };

/**
 * Reports a listener failure without unwinding the emit loop. `reportError` is
 * the platform hook for exactly this — it reaches `window.onerror` and devtools
 * like an uncaught error while leaving the dispatch loop intact. Environments
 * without it (older browsers, Node) fall back to the console.
 */
function reportHandlerError(error: unknown): void {
  const report = (globalThis as { reportError?: (value: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(error);
}
