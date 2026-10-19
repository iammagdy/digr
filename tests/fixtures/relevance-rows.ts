/** Synthetic company rows for the strict relevance review tests (an "electricity companies in Egypt" request). */
export const contractor = {
  company_name: "Nile Electrical Contracting Co.",
  industry: "Electrical/Electronic Manufacturing",
  description: "Electrical contracting, installation of medium-voltage panels and power distribution for industrial sites.",
  location: "Cairo, Egypt",
};

export const utility = {
  company_name: "Delta Electricity Distribution Company",
  industry: "Utilities",
  description: "Distributes electricity to residential and commercial customers in the Nile Delta.",
  location: "Mansoura, Egypt",
};

export const trader = {
  company_name: "Alpha Sourcing & Trading",
  industry: "Electrical/Electronic Manufacturing",
  description: "We source electrical equipment and appliances from Asian suppliers for resale.",
  location: "Cairo, Egypt",
};

export const repair = {
  company_name: "QuickFix Home Appliances",
  industry: "Utilities",
  description: "Repair of washing machines, refrigerators and other electrical appliances at home.",
  location: "Giza, Egypt",
};

export const empty = {
  company_name: "Delta Group",
  industry: "Utilities",
  description: "",
  location: "Cairo, Egypt",
};

export const foreign = {
  company_name: "Berlin Power Systems GmbH",
  industry: "Electrical/Electronic Manufacturing",
  description: "Electrical engineering and power distribution.",
  location: "Berlin, Germany",
};

export const ELECTRICITY_CONTEXT = {
  capabilitySlug: "icypeas-companies-search",
  endpointId: "icypeas.companies.search",
  params: {
    country: "Egypt",
    industry: "الكهرباء والطاقة الكهربائية",
    query: { keyword: { include: ["electrical", "electricity"] }, location: { include: ["Egypt"] } },
  },
};
