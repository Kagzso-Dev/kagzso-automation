// The 20-row test file for Data Quality: a do-not-call number, a duplicate, bad phones,
// not interested / wrong person numbers, and a few rows with name / business / email problems.

export const DQ_HEADERS = ["Name", "Phone", "Business Name", "Email"] as const;

export const DQ_ROWS: [string, string, string, string][] = [
  ["Ravi Kumar", "9876500001", "Ravi Traders", "ravi@ravitraders.in"], // row 2  valid
  ["Priya S", "9876500002", "Priya Boutique", ""], //                    row 3  valid
  ["Arun", "9876500003", "", ""], //                                      row 4  valid, no business
  ["test", "9876500004", "Test Shop", ""], //                             row 5  valid, placeholder name
  ["", "9876500005", "Sri Balaji Stores", ""], //                         row 6  valid, no name
  ["Meena", "12345", "Meena Tailors", ""], //                             row 7  INVALID bad phone
  ["Karthik", "", "Karthik Motors", ""], //                               row 8  INVALID no phone
  ["Ravi K", "98765 00001", "Ravi Traders", ""], //                       row 9  DUPLICATE of row 2
  ["Dinesh", "9876500009", "Dinesh Hardware", ""], //                     row 10 EXCLUDED do not call
  ["Suresh", "9876500010", "Suresh Foods", ""], //                        row 11 EXCLUDED not interested
  ["Vijay", "9876500011", "Vijay Electricals", ""], //                    row 12 EXCLUDED wrong person
  ["Lakshmi", "+91 98765 00012", "Lakshmi Silks", "lakshmi@@bad"], //     row 13 valid, bad email
  ["Gopal", "9876500013", "Gopal Sweets", ""], //                         row 14 valid, already in Voicecall Contact
  ["Anitha", "9876500014", "Anitha Beauty Parlour", ""], //               row 15 valid, already in WhatsApp Contacts
  ["Mohan Raj", "9876500015", "Mohan Pharmacy", "mohan@mohanpharmacy.in"], // row 16 valid
  ["Deepa", "9876500016", "Deepa Bakery", ""], //                         row 17 valid
  ["Senthil", "9876500017", "Senthil Textiles", ""], //                   row 18 valid
  ["Kavya", "9876500018", "Kavya Cafe", ""], //                           row 19 valid
  ["Bala", "9876500019", "Bala Auto Works", ""], //                       row 20 valid
  ["Nandhini", "9876500020", "Nandhini Florist", ""], //                  row 21 valid
];

export const DQ_EXPECTED = { total: 20, valid: 14, invalid: 2, duplicates: 1, excluded: 3 };

export const DQ_DO_NOT_CALL = "+919876500009";
export const DQ_NOT_INTERESTED = "+919876500010";
export const DQ_WRONG_PERSON = "+919876500011";
export const DQ_IN_VOICECALL = "+919876500013";
export const DQ_IN_WHATSAPP = "+919876500014";

export function dqCsv(): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [DQ_HEADERS.join(","), ...DQ_ROWS.map((r) => r.map(cell).join(","))].join("\n") + "\n";
}

export function dqSheetRows(): Record<string, string>[] {
  return DQ_ROWS.map((r) => Object.fromEntries(DQ_HEADERS.map((h, i) => [h, r[i]!])));
}
