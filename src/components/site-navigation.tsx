"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./site-navigation.module.css";

const physicianLinks = [
  { href: "/", label: "首页", section: "home" },
  { href: "/encounters/demo/record", label: "病历记录", section: "record" },
  { href: "/encounters/demo/reference", label: "AI参考", section: "reference" },
  { href: "/encounters/demo/review", label: "诊疗复核", section: "review" },
  { href: "/about", label: "项目说明", section: "about" },
] as const;

const researchLinks = [
  { href: "/", label: "返回医生首页", section: "home" },
  { href: "/research", label: "研究概览", section: "overview" },
  { href: "/research/comparison", label: "公平对照", section: "comparison" },
  { href: "/profiles", label: "医生画像", section: "profiles" },
  { href: "/feedback", label: "反馈审核", section: "feedback" },
  { href: "/audit", label: "治理与审计", section: "audit" },
  { href: "/evaluation", label: "工程评测", section: "evaluation" },
] as const;

function isPhysicianPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/about" || pathname.startsWith("/encounters/");
}

function isPhysicianLinkActive(section: (typeof physicianLinks)[number]["section"], pathname: string): boolean {
  if (section === "home") return pathname === "/";
  if (section === "about") return pathname === "/about";
  if (section === "record") return pathname.endsWith("/record");
  if (section === "reference") return pathname.includes("/reference");
  return pathname.endsWith("/review");
}

function isResearchLinkActive(section: (typeof researchLinks)[number]["section"], pathname: string): boolean {
  if (section === "home") return false;
  if (section === "overview") return pathname === "/research";
  if (section === "comparison") {
    return pathname === "/workbench"
      || pathname === "/research/comparison"
      || pathname.startsWith("/research/comparison/");
  }
  const href = researchLinks.find((link) => link.section === section)?.href;
  return href !== undefined && (pathname === href || pathname.startsWith(`${href}/`));
}

export function SiteNavigation() {
  const pathname = usePathname();

  if (isPhysicianPath(pathname)) {
    return (
      <header className={styles.physicianHeader}>
        <nav className={styles.physicianNav} aria-label="医生主导航" data-capture-navigation>
          {physicianLinks.map((link, index) => {
            const isActive = isPhysicianLinkActive(link.section, pathname);
            return (
              <Link
                className={styles.physicianLink}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                data-capture-navigation-anchor={index === 0 ? "" : undefined}
                key={link.href}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </header>
    );
  }

  return (
    <header className={styles.researchHeader}>
      <div className={styles.researchHeaderInner}>
        <p className={styles.researchLabel} data-capture-navigation-anchor>研究与治理后台</p>
        <nav className={styles.researchNav} aria-label="研究与治理导航" data-capture-navigation>
          {researchLinks.map((link) => {
            const isActive = isResearchLinkActive(link.section, pathname);
            return (
              <Link
                className={styles.researchLink}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                key={link.href}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
