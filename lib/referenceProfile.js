// Versioned style knowledge derived from the user's approved references.
// Hashes identify originals; they do not imply the PDFs are model attachments.
export const GRACE_REFERENCE_PROFILE = Object.freeze({
  id: "grace-a2-reference-v1",
  originals: [
    { name: "good-work-1(3).pdf", sha256: "8ff4088b8068fd4c2a78c10a2522ca0899e5c60fb921cfef1d4710ada674c4dc" },
    { name: "good-work-2(3).pdf", sha256: "e860683eb49ca4ffe371cd6e4a73b804755b67aa2f03b032618aff3771873578" }
  ],
  composition: "A2 landscape, large left cutaway, source plan and engineering panel on right; photo atlas in supplements",
  renderStyle: "Near-overhead axonometric, black wall cuts, white background, photographic per-room materials and furniture, no embedded labels",
  fidelity: "Preserve original plan separately. Compare generated geometry critically. Source dimensions and semantic symbol interpretation need verification.",
  originalPdfsAttachedToModel: false,
  geometryGuaranteed: false,
  referenceDeviationMeasured: false,
  sourcePages: 48,
  formats: { A2: [1683.78, 1190.55], A3: [1190.55, 841.89], A4: [595.28, 841.89] },
  // Measured from page 1 of the approved PDF, in PDF points, top-origin.
  floorLayout: {
    margin: 30, hero: [73.2244, 114, 1106.7754, 1147.551],
    sourcePlan: [1241.306, 168, 1610.473, 563],
    engineering: [1215.605, 629.551, 1636.175, 1079.551]
  },
  requiredSections: ["floor", "materials", "variants", "cabling", "server", "storage", "access", "budget", "photos", "sources", "checks", "summary"],
  structureThreshold: 0.8,
  structureScoreMeaning: "Presence of reference document sections; never a visual or factual similarity guarantee"
});
