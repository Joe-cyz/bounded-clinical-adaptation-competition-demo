import "server-only";

export type LiteratureOperationLease = {
  release(): void;
};

type Waiter = {
  kind: "mutation" | "maintenance";
  resolve: (lease: LiteratureOperationLease) => void;
};

/**
 * Coordinates file mutations with reconciliation without sleeping or polling.
 * A maintenance lease is exclusive; queued mutations are admitted in FIFO
 * order until a maintenance request reaches the head of the queue.
 */
export class LiteratureOperationCoordinator {
  private activeMutations = 0;
  private maintenanceHeld = false;
  private readonly queue: Waiter[] = [];

  enterMutation(): Promise<LiteratureOperationLease> {
    return this.enqueue("mutation");
  }

  enterMaintenance(): Promise<LiteratureOperationLease> {
    return this.enqueue("maintenance");
  }

  private enqueue(kind: Waiter["kind"]): Promise<LiteratureOperationLease> {
    return new Promise((resolve) => {
      this.queue.push({ kind, resolve });
      this.drain();
    });
  }

  private drain(): void {
    if (this.maintenanceHeld) return;
    if (this.activeMutations > 0 && this.queue[0]?.kind === "maintenance") return;

    if (this.activeMutations === 0 && this.queue[0]?.kind === "maintenance") {
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.maintenanceHeld = true;
      waiter.resolve(this.makeLease("maintenance"));
      return;
    }

    while (this.queue[0]?.kind === "mutation") {
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.activeMutations += 1;
      waiter.resolve(this.makeLease("mutation"));
    }
  }

  private makeLease(kind: Waiter["kind"]): LiteratureOperationLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (kind === "maintenance") {
          this.maintenanceHeld = false;
        } else {
          this.activeMutations -= 1;
        }
        this.drain();
      },
    };
  }
}

export const defaultLiteratureOperationCoordinator = new LiteratureOperationCoordinator();
