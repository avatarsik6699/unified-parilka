type Prototype = Record<PropertyKey, unknown>;

/**
 * Compose class method modules without constructing extra repository objects.
 * Method descriptors are copied once at module load; all calls retain the
 * MessageStore instance as `this` and therefore share one StoreCore.
 */
export function installStoreDomain(
  target: Prototype,
  source: Prototype,
): void {
  for (const name of Reflect.ownKeys(source)) {
    if (name === "constructor") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      throw new Error(`Duplicate MessageStore method: ${String(name)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    }
  }
}
