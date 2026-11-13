// KAGZSO business-outreach email templates (from "KAGZSO AI Automation Outreach Templates").
// Added to the Templates page by `npm run outreach:templates` (prisma/importOutreachTemplates.ts).
// Each one is an ordinary LETTER template: plain-letter body + signature, the same shape the
// Templates editor saves, so it can be edited, previewed and test-sent there like any other.
// The PDF's [Company Name] / [Hospital Name] / [School Name] … placeholders become
// {{business_name}}, the contact's Business name.

import { createTemplateInput, type CreateTemplateInput } from "@dispatch/shared";
import { letterToHtml } from "../render/render.js";

export const OUTREACH_SIGNATURE = [
  "Best Regards,",
  "KAGZSO Technology Services",
  "Automating Today. Empowering Tomorrow.",
  "Website: www.kagzso.com",
  "Email: admin@kagzso.com",
  "Contact: +91 9092490661",
].join("\n");

const GREETING = "Greetings from KAGZSO Technology Services.";
const OPPORTUNITIES_HEADING = "Potential automation opportunities include:";

interface SectorLetter {
  id: string;
  name: string;
  subject: string;
  intro: string;
  context: string;
  opportunities: string[];
  closing: string;
}

function opportunityList(items: string[]): string {
  return [OPPORTUNITIES_HEADING, ...items.map((item) => `• ${item}`)].join("\n");
}

function sectorBody(t: SectorLetter): string {
  return [GREETING, t.intro, t.context, opportunityList(t.opportunities), t.closing].join("\n\n");
}

const SECTOR_LETTERS: SectorLetter[] = [
  {
    id: "kagzso-outreach-01-hospitals",
    name: "KAGZSO Outreach 01 – Hospitals & Healthcare",
    subject: "AI & RPA Automation Opportunities for {{business_name}}",
    intro:
      "We are an Automation and Artificial Intelligence solutions company helping organizations improve operational efficiency through Robotic Process Automation (RPA), AI-driven workflows, and custom digital solutions.",
    context:
      "Hospitals manage high volumes of patient information, appointments, billing, claims, staff administration, and reporting. Automating suitable repetitive workflows can reduce manual effort and help teams focus more on patient care.",
    opportunities: [
      "Patient registration and data management",
      "Appointment scheduling and patient reminders",
      "Billing and insurance claim processing",
      "HR, employee onboarding, payroll inputs, and attendance",
      "Vendor invoice processing and purchase approvals",
      "MIS, compliance, and operational reporting",
      "Document management and approval workflows",
      "Laboratory and diagnostic report processing",
      "Email and workflow automation",
    ],
    closing:
      "We would appreciate an opportunity to meet your Administration, Operations, HR, Finance, or IT team. We offer a FREE initial Automation Opportunity Assessment to identify candidate processes, estimate potential time savings, and recommend practical next steps. Any savings estimates would be validated against your current workflows and technical feasibility.",
  },
  {
    id: "kagzso-outreach-02-logistics",
    name: "KAGZSO Outreach 02 – Logistics & Supply Chain",
    subject: "AI & RPA Automation Opportunities for {{business_name}}",
    intro:
      "KAGZSO helps organizations streamline operations through RPA, AI-powered workflows, document processing, and custom digital solutions.",
    context:
      "Logistics teams often manage shipment updates, transport documents, orders, invoices, customer communication, and operational reports across multiple systems. Automation can help reduce repetitive data entry and improve process visibility.",
    opportunities: [
      "Shipment tracking and status update automation",
      "Transport documentation and e-way bill data processing",
      "Order entry and delivery confirmation",
      "Invoice generation and freight billing reconciliation",
      "Proof of Delivery (POD) document extraction",
      "Vendor, transporter, and customer email processing",
      "Warehouse inventory and stock movement reporting",
      "Route and delivery performance dashboards",
      "Customer notifications, exception alerts, and payment follow-ups",
      "MIS reporting and approval workflows",
    ],
    closing:
      "We would welcome a 30-minute discussion with your Operations, Logistics, Finance, or IT team. Our FREE initial Automation Opportunity Assessment can identify suitable use cases, likely integration needs, and potential efficiency benefits. Integration with ERP, TMS, WMS, spreadsheets, and email systems is subject to technical feasibility.",
  },
  {
    id: "kagzso-outreach-03-restaurants",
    name: "KAGZSO Outreach 03 – Restaurants, Cafés & Food Chains",
    subject: "Smart Automation & AI Solutions for {{business_name}}",
    intro:
      "KAGZSO helps restaurants, cafés, cloud kitchens, and food chains improve operational efficiency through AI, RPA, workflow automation, and custom software solutions.",
    context:
      "Food businesses coordinate orders, inventory, purchasing, billing, staffing, customer feedback, and daily reports. Automating selected activities can give owners and managers more time to focus on customer experience and business growth.",
    opportunities: [
      "Sales, billing, and daily revenue reporting",
      "Inventory tracking and low-stock alerts",
      "Purchase orders and supplier coordination",
      "Ingredient consumption and wastage monitoring",
      "Customer feedback analysis",
      "WhatsApp-based enquiries, reservations, and reminders",
      "Loyalty program and promotional campaign workflows",
      "Employee attendance, shift scheduling, and payroll inputs",
      "Multi-branch sales and performance dashboards",
      "Supplier invoice processing and payment reconciliation",
      "AI-assisted sales trend analysis and demand forecasting",
      "Integration between POS, online ordering, and reporting systems",
    ],
    closing:
      "We would appreciate a short meeting with the owner, Operations Manager, or Finance team. Our FREE initial Automation Opportunity Assessment can identify practical opportunities and suitable implementation options, including POS enhancements, centralized dashboards, and customer-service workflows where feasible.",
  },
  {
    id: "kagzso-outreach-04-schools",
    name: "KAGZSO Outreach 04 – Schools",
    subject: "AI & Automation Solutions to Simplify Administration at {{business_name}}",
    intro:
      "We help educational institutions simplify administrative work through AI, RPA, workflow automation, and custom digital solutions.",
    context:
      "Schools manage student records, admissions, fees, attendance, parent communications, examination data, and routine reports. Automation can reduce repetitive administrative tasks and improve information accessibility.",
    opportunities: [
      "Admission enquiry processing and application tracking",
      "Student registration and document verification workflows",
      "Fee reminders, receipt processing, and pending-payment reports",
      "Attendance reports and parent notifications",
      "Timetable, examination, and result data processing",
      "Report card and certificate generation",
      "Parent enquiry management through email or WhatsApp",
      "Staff attendance, leave management, and payroll inputs",
      "Transport notifications and route-related communication",
      "Dashboards for admissions, fees, and attendance",
      "AI-assisted search across approved school policies and documents",
    ],
    closing:
      "Could we schedule a 30-minute discussion with your Principal, Correspondent, School Administrator, or IT team? We offer a FREE initial Automation Opportunity Assessment to understand your existing systems and recommend practical improvements. Student data access and privacy controls would be considered during solution design.",
  },
  {
    id: "kagzso-outreach-05-colleges",
    name: "KAGZSO Outreach 05 – Colleges & Universities",
    subject: "Digital Transformation, AI & RPA Opportunities for {{business_name}}",
    intro:
      "KAGZSO provides AI-driven automation and custom digital solutions to help educational institutions reduce repetitive administrative work and improve process efficiency.",
    context:
      "Colleges and universities manage workflows across admissions, examinations, student services, faculty administration, finance, placements, and accreditation reporting. Automation can reduce duplicate data entry and improve reporting consistency.",
    opportunities: [
      "Admission applications and document processing",
      "Student enrollment and academic record updates",
      "Examination scheduling and result data management",
      "Certificate, transcript, and bonafide document generation",
      "Student fee reconciliation and payment reminders",
      "Faculty attendance, leave, and workload reporting",
      "Placement registration and employer communication",
      "Scholarship application tracking and verification",
      "Accreditation and institutional MIS report preparation",
      "Research document organization and information retrieval",
      "Student support enquiry automation",
      "Department-wise dashboards and approval workflows",
    ],
    closing:
      "We would appreciate an opportunity to meet your Administration, Registrar, Examination, Finance, or IT team. Our FREE initial Automation Opportunity Assessment can identify candidate workflows, technical dependencies, and implementation priorities.",
  },
  {
    id: "kagzso-outreach-06-retail",
    name: "KAGZSO Outreach 06 – Retail Stores, Supermarkets & Shopping Chains",
    subject: "AI & Automation Solutions for Retail Operations at {{business_name}}",
    intro:
      "KAGZSO helps retail businesses streamline operations through AI, RPA, workflow automation, and custom software solutions.",
    context:
      "Retail organizations manage billing, stock availability, purchase orders, supplier invoices, sales reconciliation, promotions, and branch-level performance. Automation can improve visibility and reduce repetitive manual processing.",
    opportunities: [
      "POS sales consolidation and daily reporting",
      "Inventory monitoring and low-stock alerts",
      "Purchase order creation and supplier follow-ups",
      "Barcode, product, and pricing data management",
      "Supplier invoice extraction and reconciliation",
      "Returns, refunds, and approval workflows",
      "Multi-store sales and inventory dashboards",
      "Customer loyalty and promotional campaign automation",
      "Expiry-date monitoring where applicable",
      "Employee attendance and payroll data processing",
      "AI-assisted demand forecasting and sales analysis",
      "Finance-supporting and management reports",
    ],
    closing:
      "We would welcome a 30-minute meeting with your Retail Operations, Finance, Procurement, or IT team. Our FREE initial Automation Opportunity Assessment can identify suitable use cases and integration options for existing POS, ERP, accounting, and inventory systems.",
  },
  {
    id: "kagzso-outreach-07-manufacturing",
    name: "KAGZSO Outreach 07 – Manufacturing & Industrial Companies",
    subject: "AI, RPA & Workflow Automation Opportunities for {{business_name}}",
    intro:
      "KAGZSO helps manufacturing and industrial organizations improve operational efficiency through RPA, AI-enabled document processing, workflow automation, and custom digital solutions.",
    context:
      "Manufacturing businesses manage purchase orders, supplier documents, production reports, inventory, quality records, dispatches, invoices, and compliance reporting. Selected administrative workflows can often be streamlined without replacing core production systems.",
    opportunities: [
      "Purchase order and supplier invoice processing",
      "Inventory reconciliation and stock movement reporting",
      "Production data consolidation and shift reports",
      "Quality inspection documentation and reporting",
      "Preventive maintenance reminders and work-order workflows",
      "Dispatch documentation and shipment updates",
      "Vendor onboarding and compliance document tracking",
      "Employee attendance, shift, and payroll inputs",
      "Sales order entry and customer communication",
      "Finance reconciliation and MIS reporting",
      "AI-powered extraction from technical documents",
      "Dashboards for production, quality, and operational KPIs",
    ],
    closing:
      "We would appreciate an opportunity to connect with your Operations, Production, Finance, Supply Chain, or IT team. Our FREE initial Automation Opportunity Assessment can identify high-value use cases and implementation priorities. Any direct machine or operational-technology integration would require a separate technical and safety assessment.",
  },
  {
    id: "kagzso-outreach-08-real-estate",
    name: "KAGZSO Outreach 08 – Real Estate, Property Management & Construction",
    subject: "AI & Automation Solutions for {{business_name}} – Real Estate Operations",
    intro:
      "KAGZSO provides AI, RPA, workflow automation, and custom software solutions to help real estate companies, property managers, builders, and construction organizations simplify operations.",
    context:
      "These businesses coordinate customer enquiries, site documentation, quotations, approvals, vendor bills, project reports, payment follow-ups, and maintenance requests. Automation can improve response times and management visibility.",
    opportunities: [
      "Website enquiry and property lead management",
      "Lead assignment and follow-up reminders",
      "Customer appointment and site-visit scheduling",
      "Property document organization and data extraction",
      "Quotation, agreement, and approval workflows",
      "Construction progress reports and project dashboards",
      "Vendor invoice processing and purchase approvals",
      "Customer payment reminders and outstanding reports",
      "Apartment maintenance requests and complaint tracking",
      "Tenant onboarding, lease reminders, and renewal tracking",
      "Contractor attendance and work-report consolidation",
      "AI-powered document search and project information retrieval",
    ],
    closing:
      "We would welcome a brief discussion with your Management, Sales, Projects, Accounts, or Property Operations team. Our FREE initial Automation Opportunity Assessment can identify practical use cases and opportunities to connect existing CRM, ERP, accounting, or property-management systems.",
  },
  {
    id: "kagzso-outreach-09-finance",
    name: "KAGZSO Outreach 09 – Finance, Accounting & Professional Services",
    subject: "AI & RPA Automation for Finance and Back-Office Operations at {{business_name}}",
    intro:
      "KAGZSO helps organizations automate repetitive finance and back-office activities through RPA, AI-powered document processing, and workflow automation.",
    context:
      "Teams often spend significant time processing invoices, reconciling transactions, updating spreadsheets, preparing reports, managing documents, and following up on approvals. Automation can streamline these workflows while retaining appropriate review and authorization controls.",
    opportunities: [
      "Accounts payable and receivable workflows",
      "Invoice data extraction and validation",
      "Bank and ledger reconciliation support",
      "Expense claim processing and approval routing",
      "Payment reminders and outstanding follow-ups",
      "Purchase order and invoice matching",
      "Financial report consolidation and MIS preparation",
      "Client onboarding and document collection",
      "Document classification and information extraction",
      "Tax-related data collation and supporting reports",
      "Employee reimbursement and payroll data processing",
      "Audit evidence collection and compliance tracking",
    ],
    closing:
      "We would appreciate an opportunity to meet your Finance, Accounts, Operations, or IT team. Our FREE initial Automation Opportunity Assessment can identify suitable workflows, expected time savings, and potential implementation benefits. Financial approvals and regulated decisions remain subject to your organization's controls.",
  },
  {
    id: "kagzso-outreach-10-ecommerce",
    name: "KAGZSO Outreach 10 – E-commerce & Online Businesses",
    subject: "AI & Automation Solutions to Scale {{business_name}}'s Operations",
    intro:
      "KAGZSO helps e-commerce businesses improve operational efficiency through AI, RPA, workflow automation, and custom software development.",
    context:
      "Online businesses handle large volumes of orders, product updates, customer enquiries, inventory changes, returns, refunds, payment reconciliation, and performance reports. Automation can reduce repetitive work as transaction volumes grow.",
    opportunities: [
      "Order processing and order-status updates",
      "Product listing and catalog data management",
      "Inventory synchronization across sales channels",
      "Customer enquiry classification and response workflows",
      "Return, refund, and replacement processing",
      "Payment gateway and order reconciliation",
      "Shipping label and dispatch documentation workflows",
      "Supplier invoice processing and purchase orders",
      "Review and customer feedback analysis",
      "Sales, advertising, and profitability dashboards",
      "Low-stock and order-exception alerts",
      "AI-assisted demand forecasting and customer support",
    ],
    closing:
      "We would welcome a 30-minute discussion about your current workflows. Our FREE initial Automation Opportunity Assessment can identify candidate use cases, integration requirements, and potential business benefits across your e-commerce platforms, marketplaces, inventory systems, shipping tools, and accounting applications.",
  },
  {
    id: "kagzso-outreach-11-hotels",
    name: "KAGZSO Outreach 11 – Hotels, Resorts & Hospitality",
    subject: "AI & Automation Opportunities for {{business_name}}",
    intro:
      "KAGZSO helps hospitality businesses streamline guest services and back-office operations through AI, RPA, and custom digital solutions.",
    context:
      "Hotels and resorts coordinate reservations, guest enquiries, housekeeping, billing, purchasing, employee schedules, and management reporting. Automating repetitive workflows can improve response times and help staff focus on guest experience.",
    opportunities: [
      "Reservation enquiry management and confirmation workflows",
      "Guest communication and pre-arrival reminders",
      "Check-in and check-out administrative workflows",
      "Housekeeping task allocation and status tracking",
      "Room-service requests and maintenance ticket routing",
      "Billing, invoice processing, and reconciliation",
      "Inventory and purchasing workflows",
      "Staff attendance, leave, and shift reporting",
      "Guest feedback analysis and service alerts",
      "Occupancy, revenue, and departmental dashboards",
      "WhatsApp-based guest enquiries and FAQs",
      "Multi-property reporting and approval workflows",
    ],
    closing:
      "We would welcome a 30-minute meeting with your General Manager, Front Office, Finance, Operations, or IT team. Our FREE initial Automation Opportunity Assessment can identify operational bottlenecks and potential integrations with existing property-management, booking, POS, and accounting systems.",
  },
  {
    id: "kagzso-outreach-12-corporate",
    name: "KAGZSO Outreach 12 – Corporate Offices, IT Services & BPO",
    subject: "Reduce Repetitive Business Work with AI & RPA – KAGZSO",
    intro:
      "KAGZSO supports organizations in automating repetitive business processes through RPA, AI-driven workflows, document intelligence, and custom software solutions.",
    context:
      "Corporate offices, shared services, and BPO teams often spend significant time on data entry, spreadsheet updates, email handling, application-to-application transfers, reporting, and routine approvals.",
    opportunities: [
      "Email classification and request routing",
      "Data extraction and entry across business applications",
      "Excel and spreadsheet processing",
      "Employee onboarding and offboarding workflows",
      "HR, payroll, and attendance reporting",
      "Invoice processing and financial reconciliation",
      "CRM updates and customer record maintenance",
      "Document extraction, classification, and validation",
      "Automated report generation and distribution",
      "SLA monitoring and escalation alerts",
      "AI-assisted internal knowledge search",
      "Power Automate, UiPath, and workflow integrations",
      "Power Apps, Power BI, and custom application development",
    ],
    closing:
      "We would appreciate the opportunity to connect with your Operations, Shared Services, HR, Finance, or IT team for a 30-minute discussion. Our FREE initial Automation Opportunity Assessment can identify suitable workflows, integration needs, and potential time-saving opportunities.",
  },
  {
    id: "kagzso-outreach-13-pharma",
    name: "KAGZSO Outreach 13 – Pharmaceuticals & Distributors",
    subject: "AI & RPA Automation Opportunities for {{business_name}}",
    intro:
      "KAGZSO helps pharmaceutical companies and distributors streamline operational and administrative processes using AI, RPA, and custom digital solutions.",
    context:
      "Pharmaceutical organizations manage product documentation, inventory, purchase orders, batch records, distribution information, and compliance-related reporting. Automating selected workflows can improve traceability and processing efficiency.",
    opportunities: [
      "Purchase order and supplier invoice processing",
      "Stock, batch, and expiry-date reporting",
      "Distributor order entry and order-status notifications",
      "Sales data consolidation and territory-wise reporting",
      "Product document classification and retrieval",
      "Quality documentation and approval tracking",
      "Vendor and distributor onboarding workflows",
      "Invoice reconciliation and payment follow-ups",
      "Regulatory documentation tracking and report preparation",
      "Email-based request classification and routing",
      "Inventory and sales dashboards",
      "AI-powered search across approved product documentation",
    ],
    closing:
      "We would be pleased to conduct a FREE initial Automation Opportunity Assessment with your Operations, Supply Chain, Finance, Quality, or IT team. Processes involving regulated records or quality decisions would require appropriate validation, access controls, and human review.",
  },
  {
    id: "kagzso-outreach-14-universal",
    name: "KAGZSO Outreach 14 – Universal Business Outreach",
    subject: "Explore AI, Automation & Custom Software Opportunities with KAGZSO",
    intro:
      "We help businesses improve operational efficiency through AI solutions, Robotic Process Automation (RPA), workflow automation, and custom software development.",
    context:
      "Whether your organization wants to automate existing processes, develop a new business application, integrate multiple systems, or explore how AI can address a business challenge, our team can assess your requirements and recommend a suitable solution.",
    opportunities: [
      "AI-powered business workflows and document processing",
      "RPA for repetitive tasks and application integration",
      "Custom web applications and business portals",
      "Microsoft Power Automate, Power Apps, and Power BI solutions",
      "Reporting, dashboards, and data processing automation",
      "Business process optimization and digital transformation",
    ],
    closing:
      "We offer a FREE initial Automation & AI Feasibility Assessment to understand your needs and identify potential opportunities. Would you be available for a short 20-minute discussion? We would be happy to arrange an online meeting or visit your office at a mutually convenient time.",
  },
];

const FOLLOW_UP = {
  id: "kagzso-outreach-15-follow-up",
  name: "KAGZSO Outreach 15 – Universal Follow-up",
  subject: "Follow-up: AI & Automation Opportunities for {{business_name}}",
  bodyText: [
    "Dear Sir/Madam,",
    GREETING,
    "I am following up on my previous email regarding AI, Robotic Process Automation (RPA), and workflow automation opportunities for {{business_name}}.",
    "We understand that organizations across industries face challenges such as repetitive manual work, data entry, multiple-system updates, reporting delays, and increasing operational workloads.",
    opportunityList([
      "Reduce repetitive manual activities",
      "Improve data accuracy and processing speed",
      "Streamline approvals and document workflows",
      "Integrate existing applications and business systems",
      "Improve operational visibility through dashboards and reports",
      "Identify measurable time and cost-saving opportunities",
    ]),
    "We would be happy to provide a FREE initial Automation Opportunity Assessment to identify suitable use cases, potential time savings, and recommended next steps.",
    "Would it be possible to schedule a brief 20–30-minute discussion with your team? We can arrange an online meeting or visit your office at a mutually convenient time.",
    "Thank you for your time and consideration. We look forward to the opportunity to work with your organization.",
  ].join("\n\n"),
};

export type OutreachTemplate = CreateTemplateInput & { id: string; htmlBody: string };

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Same create input the Templates editor's Save sends, plus a fixed id and the derived HTML. */
function toTemplate(t: { id: string; name: string; subject: string; bodyText: string }): OutreachTemplate {
  const used = [...`${t.subject}\n${t.bodyText}`.matchAll(VAR_RE)].map((m) => m[1]!);
  const input = createTemplateInput.parse({
    name: t.name,
    kind: "LETTER",
    subject: t.subject,
    bodyText: t.bodyText,
    signature: OUTREACH_SIGNATURE,
    // Declared so the editor's preview / test send shows «business_name» in its place.
    variables: [...new Set(used)],
  });
  return { ...input, id: t.id, htmlBody: letterToHtml(input.bodyText!, input.signature) };
}

/** All 15 templates, in the PDF's order (01 Hospitals … 15 Follow-up). */
export function outreachTemplates(): OutreachTemplate[] {
  return [
    ...SECTOR_LETTERS.map((t) => toTemplate({ id: t.id, name: t.name, subject: t.subject, bodyText: sectorBody(t) })),
    toTemplate(FOLLOW_UP),
  ];
}

export type OutreachPlanStep =
  | { action: "create"; template: OutreachTemplate }
  | { action: "skip"; template: OutreachTemplate; reason: string };

/**
 * Add-only: a template whose id or name is already on the server is left exactly as it is,
 * so re-running never overwrites edits made in the Templates page and never makes duplicates.
 */
export function planOutreachImport(
  templates: OutreachTemplate[],
  existing: Array<{ id: string; name: string }>,
): OutreachPlanStep[] {
  const ids = new Set(existing.map((e) => e.id));
  const names = new Set(existing.map((e) => e.name.trim().toLowerCase()));
  return templates.map((template) => {
    if (ids.has(template.id)) return { action: "skip", template, reason: "already added" };
    if (names.has(template.name.trim().toLowerCase())) {
      return { action: "skip", template, reason: "a template with this name already exists" };
    }
    return { action: "create", template };
  });
}
