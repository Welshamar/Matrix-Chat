"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { loadSession } from "@/lib/auth";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace(loadSession() ? "/chat" : "/login");
  }, [router]);

  return <div className="loading-screen">Loading Matrix Chat...</div>;
}
