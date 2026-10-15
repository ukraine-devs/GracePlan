import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export async function createConceptReviewPdf({ renderData, planData, photoCount }) {
  if (!renderData?.startsWith("data:image/png;base64,") || !planData?.startsWith("data:image/jpeg;base64,")) {
    throw new Error("A render and source plan are required for the A2 review sheet.");
  }
  const pdf = await PDFDocument.create();
  const width = 1683.78;
  const height = 1190.55;
  const page = pdf.addPage([width, height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const render = await pdf.embedPng(renderData.split(",")[1]);
  const plan = await pdf.embedJpg(planData.split(",")[1]);

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 28, y: 1144, width: 36, height: 3, color: rgb(.82, .44, .58) });
  page.drawText("A2-01  |  CONCEPT REVIEW", { x: 75, y: 1139, size: 12, font: bold, color: rgb(.36,.4,.42) });
  page.drawText("Grace Plan / floor concept", { x: 28, y: 1097, size: 32, font: bold, color: rgb(.11,.15,.17) });
  page.drawText("Security, data and access proposal - visualization pending verification", { x: 28, y: 1070, size: 12, font: regular, color: rgb(.4,.44,.45) });

  const left = { x: 28, y: 98, w: 1085, h: 945 };
  const rs = Math.min(left.w / render.width, left.h / render.height);
  const rw = render.width * rs, rh = render.height * rs;
  page.drawImage(render, { x: left.x + (left.w - rw) / 2, y: left.y + (left.h - rh) / 2, width: rw, height: rh });

  const rightX = 1190, rightW = 440;
  page.drawText("01  SOURCE 2D PLAN", { x: rightX, y: 1033, size: 15, font: bold, color: rgb(.11,.15,.17) });
  const ps = Math.min(rightW / plan.width, 390 / plan.height);
  const pw = plan.width * ps, ph = plan.height * ps;
  page.drawImage(plan, { x: rightX + (rightW - pw) / 2, y: 623 + (390 - ph) / 2, width: pw, height: ph });

  page.drawText("02  ENGINEERING POINTS", { x: rightX, y: 560, size: 15, font: bold, color: rgb(.11,.15,.17) });
  page.drawRectangle({ x: rightX, y: 215, width: rightW, height: 318, borderColor: rgb(.82,.84,.85), borderWidth: 1, color: rgb(.985,.985,.985) });
  page.drawText("No confirmed locations or cable routes", { x: rightX + 23, y: 380, size: 14, font: bold, color: rgb(.35,.38,.4) });
  page.drawText("Plan calibration and room-photo links required.", { x: rightX + 23, y: 355, size: 12, font: regular, color: rgb(.45,.48,.49) });
  page.drawText("C / AP / D / FD positions not invented.", { x: rightX + 23, y: 335, size: 12, font: regular, color: rgb(.45,.48,.49) });

  page.drawLine({ start: { x: 28, y: 77 }, end: { x: width - 28, y: 77 }, thickness: .6, color: rgb(.8,.8,.8) });
  page.drawText("Conceptual image, not BIM/IFC. Source photographs: " + photoCount + ". No 21% conformance claim.", { x: 28, y: 51, size: 10, font: regular, color: rgb(.42,.46,.47) });
  page.drawText("A2 LANDSCAPE  |  DRAFT  |  01", { x: 1440, y: 51, size: 10, font: bold, color: rgb(.3,.33,.34) });

  const bytes = await pdf.save();
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}
