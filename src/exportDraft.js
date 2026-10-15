import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

async function embedDataImage(pdf, dataUrl) {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl || "");
  if (!match) throw new Error("Unsupported image data in PDF export.");
  return match[1].toLowerCase() === "png" ? pdf.embedPng(match[2]) : pdf.embedJpg(match[2]);
}

function drawFitted(page, image, box) {
  const scale = Math.min(box.w / image.width, box.h / image.height);
  const width = image.width * scale, height = image.height * scale;
  page.drawImage(image, { x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2, width, height });
}

export async function createConceptReviewPdf({ renderData, planData, photoCount, contactSheets = [] }) {
  if (!renderData?.startsWith("data:image/png;base64,") || !planData?.startsWith("data:image/jpeg;base64,")) {
    throw new Error("A render and source plan are required for the A2 review sheet.");
  }
  const pdf = await PDFDocument.create();
  const width = 1683.78;
  const height = 1190.55;
  const page = pdf.addPage([width, height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const render = await embedDataImage(pdf, renderData);
  const plan = await embedDataImage(pdf, planData);
  const contacts = await Promise.all(contactSheets.slice(0, 4).map((data) => embedDataImage(pdf, data)));

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 28, y: 1144, width: 36, height: 3, color: rgb(.82, .44, .58) });
  page.drawText("A2-01  |  CONCEPT REVIEW", { x: 75, y: 1139, size: 12, font: bold, color: rgb(.36,.4,.42) });
  page.drawText("Grace Plan / floor concept", { x: 28, y: 1097, size: 32, font: bold, color: rgb(.11,.15,.17) });
  page.drawText("Security, data and access proposal - visualization pending verification", { x: 28, y: 1070, size: 12, font: regular, color: rgb(.4,.44,.45) });

  const left = { x: 28, y: 98, w: 1085, h: 945 };
  drawFitted(page, render, left);

  const rightX = 1190, rightW = 440;
  page.drawText("01  SOURCE 2D PLAN", { x: rightX, y: 1033, size: 15, font: bold, color: rgb(.11,.15,.17) });
  drawFitted(page, plan, { x: rightX, y: 623, w: rightW, h: 390 });

  page.drawText("02  ENGINEERING POINTS", { x: rightX, y: 560, size: 15, font: bold, color: rgb(.11,.15,.17) });
  page.drawRectangle({ x: rightX, y: 215, width: rightW, height: 318, borderColor: rgb(.82,.84,.85), borderWidth: 1, color: rgb(.985,.985,.985) });
  page.drawText("No confirmed locations or cable routes", { x: rightX + 23, y: 380, size: 14, font: bold, color: rgb(.35,.38,.4) });
  page.drawText("Plan calibration and room-photo links required.", { x: rightX + 23, y: 355, size: 12, font: regular, color: rgb(.45,.48,.49) });
  page.drawText("C / AP / D / FD positions not invented.", { x: rightX + 23, y: 335, size: 12, font: regular, color: rgb(.45,.48,.49) });

  page.drawLine({ start: { x: 28, y: 77 }, end: { x: width - 28, y: 77 }, thickness: .6, color: rgb(.8,.8,.8) });
  page.drawText("Conceptual image, not BIM/IFC. Source photographs: " + photoCount + ". No 21% conformance claim.", { x: 28, y: 51, size: 10, font: regular, color: rgb(.42,.46,.47) });
  page.drawText("A2 LANDSCAPE  |  DRAFT  |  01", { x: 1440, y: 51, size: 10, font: bold, color: rgb(.3,.33,.34) });

  const sheets = [
    ["A2-02  |  CCTV AND SECURITY", "Proposed camera fields and security points", ["C / AP / D / FD / S / R identifiers", "Locations require measured confirmation", "Pink fields: conceptual camera coverage"]],
    ["A2-03  |  NETWORKS", "Data routes and engineering points", ["Blue: Cat6 and data routes", "Ochre: 230 V power", "Rack, NAS, NVR and floor distribution"]],
    ["A2-04  |  POWER AND CABLES", "PoE, UPS and cable schedule", ["Measured polylines required for exact lengths", "Reserve and vertical sections calculated separately", "Device passport loads required"]],
    ["A2-05  |  ACCESS AND STORAGE", "Access matrix, NAS and recovery", ["Separate administration, staff and guest zones", "Local and hybrid storage variants", "VPN, backup and restore plan"]],
    ["A2-06  |  QA AND EVIDENCE", "Completeness and print control", ["Photos accounted: " + photoCount, "Six A2 sheets generated", "BIM/IFC requires calibrated geometry"]]
  ];
  sheets.forEach(([code, title, notes], index) => {
    const extra = pdf.addPage([width, height]);
    extra.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1,1,1) });
    extra.drawRectangle({ x: 28, y: 1144, width: 36, height: 3, color: rgb(.82,.44,.58) });
    extra.drawText(code, { x: 75, y: 1139, size: 12, font: bold, color: rgb(.36,.4,.42) });
    extra.drawText(title, { x: 28, y: 1097, size: 30, font: bold, color: rgb(.11,.15,.17) });
    const box = { x: 28, y: 140, w: 1040, h: 860 };
    if (index === 4 && contacts.length) {
      const columns = contacts.length > 1 ? 2 : 1;
      const rows = Math.ceil(contacts.length / columns);
      contacts.forEach((image, contactIndex) => {
        const cell = { x: box.x + (contactIndex % columns) * (box.w / columns), y: box.y + (rows - 1 - Math.floor(contactIndex / columns)) * (box.h / rows), w: box.w / columns - 12, h: box.h / rows - 12 };
        extra.drawRectangle({ x: cell.x, y: cell.y, width: cell.w, height: cell.h, borderColor: rgb(.86,.86,.86), borderWidth: 1 });
        drawFitted(extra, image, { x: cell.x + 6, y: cell.y + 6, w: cell.w - 12, h: cell.h - 12 });
      });
    } else {
      drawFitted(extra, index === 4 ? render : plan, box);
      if (index < 3) {
        const routeColor = index === 0 ? rgb(.82,.44,.58) : index === 1 ? rgb(.18,.46,.75) : rgb(.78,.54,.16);
        extra.drawLine({ start: { x: 180, y: 330 }, end: { x: 490, y: 620 }, thickness: 6, color: routeColor, opacity: .72 });
        extra.drawLine({ start: { x: 490, y: 620 }, end: { x: 850, y: 540 }, thickness: 6, color: routeColor, opacity: .72 });
        extra.drawCircle({ x: 180, y: 330, size: 12, color: routeColor });
        extra.drawCircle({ x: 850, y: 540, size: 12, color: routeColor });
        extra.drawText("CONCEPTUAL / VERIFY ON SITE", { x: 56, y: 168, size: 11, font: bold, color: routeColor });
      }
    }
    extra.drawRectangle({ x: 1120, y: 140, width: 520, height: 860, borderColor: rgb(.82,.84,.85), borderWidth: 1, color: rgb(.985,.985,.985) });
    extra.drawText("GRACE PLAN", { x: 1150, y: 950, size: 17, font: bold, color: rgb(.11,.15,.17) });
    notes.forEach((note, i) => extra.drawText(note, { x: 1150, y: 905-i*34, size: 12, font: regular, color: rgb(.4,.44,.45) }));
    extra.drawText("Concept package. Verify scale, geometry and engineering points.", { x: 1150, y: 220, size: 11, font: regular, color: rgb(.4,.44,.45) });
    extra.drawLine({ start: { x: 28, y: 77 }, end: { x: width-28, y: 77 }, thickness: .6, color: rgb(.8,.8,.8) });
    extra.drawText("GRACE PLAN  |  A2 LANDSCAPE  |  " + String(index+2).padStart(2,"0"), { x: 28, y: 51, size: 10, font: bold, color: rgb(.3,.33,.34) });
  });

  if (pdf.getPageCount() !== 6) throw new Error("PDF export must contain exactly six A2 sheets.");
  for (const sheet of pdf.getPages()) {
    const size = sheet.getSize();
    if (Math.abs(size.width - width) > 1 || Math.abs(size.height - height) > 1) throw new Error("Invalid A2 page size.");
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  if (bytes.length < 10000) throw new Error("Generated PDF is unexpectedly small.");
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}
