import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TemplateFormCard from "../src/app/dashboard/chat/components/TemplateFormCard";
import Composer from "../src/app/dashboard/chat/components/Composer";
import { TEMPLATE_FORMS } from "../src/lib/templateForms";

describe("pending sends", () => {
  it("the template send shows a pending label and is disabled while a request is outstanding", () => {
    const html = renderToStaticMarkup(createElement(TemplateFormCard, {form: TEMPLATE_FORMS[0], onSend: () => {}, onClose: () => {}, disabled: true}));
    expect(html).toMatch(/disabled="" data-testid="template-form-send"[^>]*>جارٍ الإرسال…/);
  });
});

it("the composer labels its pending send", () => {
  const html = renderToStaticMarkup(createElement(Composer, {value: "", onChange: () => {}, onSend: () => {}, disabled: true}));
  expect(html).toContain("جارٍ الإرسال…");
});
