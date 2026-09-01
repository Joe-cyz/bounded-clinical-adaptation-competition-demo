export { physicianProfiles, syntheticCases } from "./seed-loader";

export const feedbackExamples = [
  {
    id: "feedback-low-reorder",
    label: "低风险：问题列表提前",
    input: {
      id: "feedback-low-reorder",
      changeType: "REORDER" as const,
      affectedFields: ["sectionOrder"],
      beforeText: "就诊摘要位于第一段",
      afterText: "将问题列表移动到第一段",
    },
  },
  {
    id: "feedback-medium-specialty",
    label: "中风险：改变专科字段优先级",
    input: {
      id: "feedback-medium-specialty",
      changeType: "REORDER" as const,
      affectedFields: ["specialtyPriority"],
      beforeText: "使用已批准的内分泌随访顺序",
      afterText: "长期把某项检查设为所有病例的第一优先级",
    },
  },
  {
    id: "feedback-high-allergy",
    label: "高风险：删除过敏史",
    input: {
      id: "feedback-high-allergy",
      changeType: "DELETE" as const,
      affectedFields: ["allergies"],
      beforeText: "保留过敏史字段",
      afterText: "以后省略过敏史以节省时间",
    },
  },
  {
    id: "feedback-high-medication",
    label: "高风险：默认用药",
    input: {
      id: "feedback-high-medication",
      changeType: "ADD" as const,
      affectedFields: ["currentMedications"],
      beforeText: "没有自动用药建议",
      afterText: "遇到类似情况默认推荐某药及固定剂量",
    },
  },
];
