#!/bin/bash

# Performance Diagnostic Script for Function Scanner
# Run this to identify performance bottlenecks in your workspace

set -e

echo "🔍 Function Scanner Performance Diagnostics"
echo "=========================================\n"

# 1. Check system resources
echo "📊 System Resources:"
echo "  CPU Cores: $(nproc 2>/dev/null || echo 'N/A')"
echo "  Memory: $(free -h 2>/dev/null | awk '/^Mem/ {print $2}' || echo 'N/A')"
echo ""

# 2. Find and report large files
echo "📁 Large Files (may slow scanning):"
LARGE_FILES=$(find . -type f \( -name "*.ts" -o -name "*.js" -o -name "*.tsx" -o -name "*.jsx" \) -size +500k 2>/dev/null | head -10)

if [ -z "$LARGE_FILES" ]; then
    echo "  ✅ No files > 500KB found"
else
    echo "  Files larger than 500KB:"
    echo "$LARGE_FILES" | while read file; do
        SIZE=$(du -h "$file" 2>/dev/null | cut -f1)
        echo "    - $SIZE: $file"
    done
fi
echo ""

# 3. Check excluded directories
echo "📦 Excluded Directories Status:"
for dir in node_modules dist build .next out .nuxt .cache coverage; do
    if [ -d "$dir" ]; then
        COUNT=$(find "$dir" -type f \( -name "*.ts" -o -name "*.js" \) 2>/dev/null | wc -l)
        if [ "$COUNT" -gt 0 ]; then
            echo "  ⚠️  $dir/ exists and is being scanned ($COUNT files)"
        else
            echo "  ✅ $dir/ excluded (0 files)"
        fi
    else
        echo "  ✅ $dir/ doesn't exist"
    fi
done
echo ""

# 4. Count total source files
echo "📈 Source File Count:"
TOTAL_TS=$(find . -type f -name "*.ts" -o -name "*.tsx" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v build | wc -l)
TOTAL_JS=$(find . -type f -name "*.js" -o -name "*.jsx" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v build | wc -l)
TOTAL=$((TOTAL_TS + TOTAL_JS))

echo "  TypeScript files: $TOTAL_TS"
echo "  JavaScript files: $TOTAL_JS"
echo "  Total (excluding node_modules/dist/build): $TOTAL"
echo ""

# 5. Identify files with many functions
echo "📊 Large Function Files (many functions):"
FILE_FUNC_COUNT=$(find . -type f \( -name "*.ts" -o -name "*.js" \) 2>/dev/null | \
    grep -v node_modules | \
    grep -v dist | \
    grep -v build | \
    while read file; do
        # Count function declarations and arrow functions
        COUNT=$(grep -Ec "(^\s*(?:async\s+)?function\s+\w+|(\w+)\s*=\s*(?:async\s*)?=|(\w+)\s*:\s*(?:async\s*)?=>)" "$file" 2>/dev/null || echo 0)
        if [ "$COUNT" -gt 20 ]; then
            echo "$COUNT:$file"
        fi
    done | sort -rn | head -10)

if [ -z "$FILE_FUNC_COUNT" ]; then
    echo "  ✅ No files with > 20 functions found"
else
    echo "  Files with many functions:"
    echo "$FILE_FUNC_COUNT" | while IFS=: read count file; do
        echo "    - $count functions: $file"
    done
fi
echo ""

# 6. Check for minified files
echo "📦 Minified Files (should be skipped):"
MINIFIED=$(find . -type f \( -name "*.min.js" -o -name "*.min.ts" \) 2>/dev/null | \
    grep -v node_modules | grep -v dist | grep -v build | wc -l)

if [ "$MINIFIED" -eq 0 ]; then
    echo "  ✅ No minified files in source (good)"
else
    echo "  ⚠️  Found $MINIFIED minified files (these will be skipped)"
fi
echo ""

# 7. Performance estimation
echo "⏱️  Estimated Scan Time:"
ESTIMATED_MS=$((TOTAL * 1))  # ~1ms per file after optimizations
ESTIMATED_SEC=$(echo "scale=2; $ESTIMATED_MS / 1000" | bc)
echo "  Based on $TOTAL files @ 1ms/file: ~${ESTIMATED_SEC}s"
echo ""

echo "Recommendations:"
if [ "$TOTAL" -gt 500 ]; then
    echo "  ⚠️  Workspace is large (>500 files)"
    echo "     - Consider using higher concurrency (16-32)"
    echo "     - Check for files > 500KB that could be excluded"
fi

if [ "$MINIFIED" -gt 10 ]; then
    echo "  ⚠️  Many minified files in source"
    echo "     - Move to dist/ or exclude them"
fi

if [ -z "$LARGE_FILES" ]; then
    echo "  ✅ File sizes look good"
fi

echo ""
echo "Next Steps:"
echo "  1. Run: npm run perf-test (to measure actual performance)"
echo "  2. Read: docs/PERFORMANCE_OPTIMIZATION.md (for tuning tips)"
echo "  3. Check: output panel during scan for timing info"
