import { useLayoutEffect, useRef, useState } from "react";
import {
  ObjectManager as OrihonObjectManager,
  objectManager,
  type ManagedObject,
  type ObjectFilter,
  type ObjectId,
  type ObjectManagerOptions
} from "../services/object-manager.js";
import { useMap } from "./context.js";

export interface ObjectManagerProps extends ObjectManagerOptions {
  objects: Array<ManagedObject & { id: ObjectId }>;
  filter?: ObjectFilter | null;
  onReady?: (manager: OrihonObjectManager) => void;
}

export function ObjectManager({ objects, filter = null, onReady, ...options }: ObjectManagerProps) {
  const map = useMap();
  const [manager] = useState(() => objectManager(options));
  const previous = useRef(new globalThis.Map<ObjectId, ManagedObject>());

  useLayoutEffect(() => {
    manager.addTo(map);
    onReady?.(manager);
    // Keep indexed data across React Strict Mode's development setup/cleanup replay.
    // The manager becomes unreachable after the real unmount, while remove() releases map resources.
    return () => { manager.remove(); };
  }, [map, manager]);

  useLayoutEffect(() => {
    const next = new globalThis.Map<ObjectId, ManagedObject>();
    const additions: ManagedObject[] = [];
    const updates: ManagedObject[] = [];
    for (const object of objects) {
      next.set(object.id, object);
      if (!previous.current.has(object.id)) additions.push(object);
      else if (previous.current.get(object.id) !== object) updates.push(object);
    }
    const removals = [...previous.current.keys()].filter((id) => !next.has(id));
    if (removals.length) manager.remove(removals);
    if (additions.length) manager.add(additions);
    if (updates.length) manager.update(updates);
    previous.current = next;
  }, [manager, objects]);

  useLayoutEffect(() => { manager.setFilter(filter); }, [manager, filter]);
  return null;
}
