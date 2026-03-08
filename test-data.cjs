const fs = require('fs');
const PDFDocument = require('pdfkit');
const officegen = require('officegen');
const ExcelJS = require('exceljs');

// 1. Generate PDF
const doc = new PDFDocument();
doc.pipe(fs.createWriteStream('private_data/project_titan.pdf'));
doc.fontSize(16).text('PDF SECRET DATA: Project Titan launch is delayed to 2026 due to supply chain issues.', 100, 100);
doc.end();

// 2. Generate DOCX
const docx = officegen('docx');
const pObj = docx.createP();
pObj.addText('WORD SECRET DATA: The CEO is voluntarily stepping down next month to pursue philanthropic endeavors.');
const out = fs.createWriteStream('private_data/ceo_transition.docx');
docx.generate(out);

// 3. Generate XLSX
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('M&A Targets');
sheet.addRow(['Status', 'Target', 'Offer']);
sheet.addRow(['Active', 'Startup X', '$50M']);
sheet.addRow(['Passed', 'Company Y', '$12M']);
workbook.xlsx.writeFile('private_data/acquisitions.xlsx').then(() => {
    console.log("All test files generated successfully.");
});
