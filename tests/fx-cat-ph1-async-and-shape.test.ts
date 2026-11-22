import { describe, expect, it } from "vitest";
import { readShape } from "../src/lib/treg/shapeReader";

describe("FX-CAT Ph1 Phase 4A: Shape Inference Fallbacks", () => {
  it("infers deeply nested list at response.batches.0.listings when list_path is NOT FOUND", () => {
    const payload = {
      response: {
        batches: [
          {
            batch_id: "b1",
            listings: [
              { id: "item1", title: "Product 1", price: 100 },
              { id: "item2", title: "Product 2", price: 200 },
            ],
          },
        ],
      },
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("inferred_list");
    expect(r.listPath).toBe("response.batches.0.listings");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].id).toBe("item1");
    expect(r.rows[1].price).toBe(200);
  });

  it("infers single object under non-common key (channel_info) as single_object", () => {
    const payload = {
      ok: true,
      channel_info: {
        username: "durov",
        title: "Durov",
        subscribers: 1200000,
        description: "Official channel",
      },
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("single_object");
    expect(r.listPath).toBe("channel_info");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].username).toBe("durov");
    expect(r.rows[0].subscribers).toBe(1200000);
  });

  it("infers flat object as root_object when list_path is NOT FOUND and looksLikeOneRecord is true", () => {
    const payload = {
      username: "durov",
      title: "Durov",
      subscribers: 1200000,
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("root_object");
    expect(r.listPath).toBe("root");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].username).toBe("durov");
  });

  it("rejects non-record status wrapper (< 3 non-wrapper scalars)", () => {
    const payload = {
      status: "pending",
      message: "queued",
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("none");
    expect(r.rows).toEqual([]);
  });
});
