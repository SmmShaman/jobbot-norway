#!/usr/bin/env python3
"""
Database Admin Helper - Execute SQL via db-admin Edge Function

Usage:
    python db_admin.py "SELECT * FROM jobs LIMIT 5"
    python db_admin.py --file ../database/fix_rls_multiuser.sql
    python db_admin.py --policies  # Show current RLS policies
"""

import os
import sys
import json
import argparse
import httpx
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://db-jobbot.vitalii.no")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")


def execute_sql(sql: str, verbose: bool = False) -> dict:
    """Execute SQL via db-admin Edge Function."""
    if not SERVICE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY not found in .env")
        sys.exit(1)

    url = f"{SUPABASE_URL}/functions/v1/db-admin"
    headers = {
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }

    if verbose:
        print(f"Executing SQL ({len(sql)} chars)...")
        if len(sql) < 500:
            print(f"SQL: {sql}")
        else:
            print(f"SQL: {sql[:200]}... (truncated)")

    try:
        response = httpx.post(url, json={"sql": sql}, headers=headers, timeout=60.0)
        result = response.json()

        if verbose:
            print(f"Status: {response.status_code}")

        return result
    except httpx.RequestError as e:
        return {"success": False, "error": f"Request failed: {e}"}
    except json.JSONDecodeError:
        return {"success": False, "error": f"Invalid JSON response: {response.text}"}


def read_sql_file(filepath: str) -> str:
    """Read SQL from a file."""
    with open(filepath, "r") as f:
        return f.read()


def show_rls_policies():
    """Show current RLS policies for main tables."""
    sql = """
    SELECT tablename, policyname, cmd, qual::text
    FROM pg_policies
    WHERE schemaname = 'public'
    AND tablename IN ('jobs', 'applications', 'cv_profiles', 'user_settings')
    ORDER BY tablename, policyname;
    """
    result = execute_sql(sql)

    if result.get("success"):
        rows = result.get("rows", [])
        if not rows:
            print("No RLS policies found!")
            return

        print(f"\n{'='*80}")
        print("RLS POLICIES")
        print(f"{'='*80}\n")

        current_table = None
        for row in rows:
            if row.get("tablename") != current_table:
                current_table = row.get("tablename")
                print(f"\n[{current_table}]")

            print(f"  {row.get('cmd'):6} | {row.get('policyname')}")
            qual = row.get("qual", "")
            if qual and qual != "true":
                print(f"         | USING: {qual[:60]}...")
    else:
        print(f"Error: {result.get('error')}")


def main():
    parser = argparse.ArgumentParser(description="Execute SQL via db-admin Edge Function")
    parser.add_argument("sql", nargs="?", help="SQL query to execute")
    parser.add_argument("--file", "-f", help="Read SQL from file")
    parser.add_argument("--policies", "-p", action="store_true", help="Show RLS policies")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

    args = parser.parse_args()

    if args.policies:
        show_rls_policies()
        return

    if args.file:
        sql = read_sql_file(args.file)
    elif args.sql:
        sql = args.sql
    else:
        parser.print_help()
        return

    result = execute_sql(sql, verbose=args.verbose)

    if result.get("success"):
        rows = result.get("rows", [])
        row_count = result.get("rowCount", 0)
        command = result.get("command", "")

        print(f"\n✅ Success! Command: {command}, Rows affected: {row_count}")

        if rows:
            print(f"\nResults ({len(rows)} rows):")
            print("-" * 60)
            for i, row in enumerate(rows[:20]):  # Limit to 20 rows
                print(json.dumps(row, indent=2, default=str))
                if i < len(rows) - 1:
                    print()
            if len(rows) > 20:
                print(f"\n... and {len(rows) - 20} more rows")
    else:
        print(f"\n❌ Error: {result.get('error')}")
        if result.get("isPostgresError"):
            print("   (PostgreSQL error - check your SQL syntax)")


if __name__ == "__main__":
    main()
