#!/bin/bash
# 初始化数组和变量
MIN_SIZE=$((10 * 1024 * 1024))  # 10M in bytes
declare -a platforms=()
declare -a archs=()
declare -a langs=()
sign=false
# Windows signing service URL — set WIN_SIGN_URL in environment to override
WIN_SIGN_URL="${WIN_SIGN_URL:-http://localhost:1999/upload}"

win_x64_cmd="pack:win64"
win_x64_suffix="exe"
win_x64_identifier="win_x64"

win_x32_cmd="pack:win32"
win_x32_suffix="exe"
win_x32_identifier="win_ia32"

mac_x64_cmd="pack:intel"
mac_x64_suffix="dmg"
mac_x64_identifier="mac_x64"

mac_arm_cmd="pack:m1"
mac_arm_suffix="dmg"
mac_arm_identifier="mac_arm64"

linux_x64_cmd="pack:linux"
linux_x64_suffix="AppImage"
linux_x64_identifier="linux_x64"

linux_arm_cmd="pack:linuxarm"
linux_arm_suffix="AppImage"
linux_arm_identifier="linux_arm64"
# 帮助信息
usage() {
    cat << EOF
Usage: $(basename "$0") -p <platform> -a <arch> [-l <lang>] [-s]

Options:
    -p  Platform (Required, Multiple): win|mac|linux
    -a  Architecture (Required, Multiple): x64|x32|arm
    -l  Language (Optional, Multiple): Add supported locales here; value flows into -c.extraMetadata.initRegion
    -s  Sign (Optional)
    -h  Show this help

Environment:
    WIN_SIGN_URL  Windows signing service URL (default: http://localhost:1999/upload)
                  The service should accept: POST multipart/form-data with file=@<path>
                  and return the signed binary. Response must be > 10MB to be accepted.

Example:
    $(basename "$0") -p win -p mac -a x64 -a arm -l en -l ja -s
EOF
    exit 1
}

# 验证平台参数
validate_platform() {
    case "$1" in
        win|mac|linux) return 0 ;;
        *) echo "Invalid platform: $1. Must be win, mac, or linux" >&2; exit 1 ;;
    esac
}

# 验证架构参数
validate_arch() {
    case "$1" in
        x64|x32|arm) return 0 ;;
        *) echo "Invalid architecture: $1. Must be x64, x32, or arm" >&2; exit 1 ;;
    esac
}

# 验证语言参数 — add your supported locales here
validate_lang() {
    case "$1" in
        en|ja) return 0 ;;
        *) echo "Invalid language: $1. Must be en or ja" >&2; exit 1 ;;
    esac
}

# 解析参数
while getopts "p:a:l:sh" opt; do
    case $opt in
        p)
            validate_platform "$OPTARG"
            platforms+=("$OPTARG")
            ;;
        a)
            validate_arch "$OPTARG"
            archs+=("$OPTARG")
            ;;
        l)
            validate_lang "$OPTARG"
            langs+=("$OPTARG")
            ;;
        s)
            sign=true
            ;;
        h)
            usage
            ;;
        ?)
            usage
            ;;
    esac
done

# 验证必选参数
if [ ${#platforms[@]} -eq 0 ]; then
    echo "Error: At least one platform (-p) is required" >&2
    usage
fi

if [ ${#archs[@]} -eq 0 ]; then
    echo "Error: At least one architecture (-a) is required" >&2
    usage
fi

if [ ${#langs[@]} -eq 0 ]; then
    langs+=("")
fi


# 输出结果
platformlist=()
for p in "${platforms[@]}"; do
    for a in "${archs[@]}"; do
        var_name="${p}_${a}_cmd"
        if [[ -n "${!var_name}" ]]; then
            platformlist+=("${p}_${a}")
        fi
    done
done

echo "build platforms: ${platformlist[@]}"
echo -e "langs: [${langs[*]}]"
echo "sign: $sign"



# 获取打包版本
asar ef build/work.asar index.html
mv index.html ./dist/index.html
# 使用 grep 和 sed 提取变量
# 提取 BUILD_DATE
web_build_date=$(grep -o '__BUILD_DATE__ = "[^"]*"' ./dist/index.html | grep -o '".*"' | tr -d '"')
# 提取 APP_VERSION
web_app_version=$(grep -o '__APP_VERSION__ = "[^"]*"' ./dist/index.html | grep -o '".*"' | tr -d '"')

# 获取 package.json 中的版本和名称
app_version=$(awk -F'[:,]' '/"version"/ {gsub(/"| |\t/, "", $2); print $2; exit}' "package.json")
app_name=$(awk -F'[:,]' '/"name"/ {gsub(/"| |\t/, "", $2); print $2; exit}' "package.json")
app_product_name=$(awk -F'[:,]' '/"productName"/ {gsub(/"| |\t/, "", $2); print $2; exit}' "package.json")

echo "app_name: $app_name"
echo "app_product_name: $app_product_name"
echo "web_app_version: $web_app_version"
echo "web_build_date: $web_build_date"


TIMEOUT=10  # 超时时间，单位为秒

echo -n "Are you sure you want to continue? (yes/no, default is no after $TIMEOUT seconds): "
read -t "$TIMEOUT" choice

if [[ "$choice" == "yes" ]]; then
    echo "Continuing..."
else
    echo "Timed out. Cancelled."
    exit 1
fi

for lang in "${langs[@]}"; do
    echo -e "\n\nlang: $lang"
    for platform in "${platformlist[@]}"; do
        start_time=$(date +%s)
        echo -e "\nstart $platform"
        var_name="${platform}_cmd"
        origin_cmd="${!var_name}"
        echo "origin_cmd: $origin_cmd"
        var_name="${platform}_suffix"
        origin_suffix="${!var_name}"
        var_name="${platform}_identifier"
        origin_identifier="${!var_name}"


        find ./dist -type f -maxdepth 1 -name "*_${web_app_version}*" -exec rm "{}" +

        TARGET_DIR="./dist/${app_name}/${web_app_version}"
        if [ -n "$lang" ]; then
            TARGET_DIR="${TARGET_DIR}/${lang}"
        fi
        mkdir -p "$TARGET_DIR"


        cmd="yarn ${origin_cmd} -c.extraMetadata.version=${web_app_version} -c.extraMetadata.initRegion=${lang}"
        if [[ "$sign" == "true" && "$platform" == mac* ]]; then
            echo "mac sign"
            cmd="CSC_LINK=./app.p12 yarn ${origin_cmd} -c.extraMetadata.version=${web_app_version} -c.extraMetadata.initRegion=${lang}"
        fi

        echo "$cmd"
        eval "$cmd"

        dist_files=($(find ./dist -maxdepth 1 -type f -name "*_${web_app_version}*" ! -name "*.blockmap"))

        if [ ${#dist_files[@]} -eq 0 ]; then
            echo "Error: No matching files found."
            exit 1
        fi

        # 移动文件
        TARGET_FILE="";
        for file in "${dist_files[@]}"; do
            ext="${file##*.}"
            echo "Moved $file to ${TARGET_DIR}/${app_product_name}_${origin_identifier}_${web_app_version}.${ext}"
            mv "${file}" "${TARGET_DIR}/${app_product_name}_${origin_identifier}_${web_app_version}.${ext}"
        done


        if [ "$sign" == "true" ]; then
            echo "start sign"
            case "$platform" in
                mac*)
                    TARGET_FILE="${TARGET_DIR}/${app_product_name}_${origin_identifier}_${web_app_version}.${origin_suffix}"
                    echo "TARGET_FILE: $TARGET_FILE"
                    # Mac signing: requires a keychain profile matching the app 'name' field in package.json
                    # Set up via: xcrun notarytool store-credentials "${app_name}" --apple-id ... --team-id ...
                    xcrun notarytool submit ${TARGET_FILE} --keychain-profile "${app_name}" --wait
                    OUTPUT=$(xcrun stapler staple "${TARGET_FILE}" 2>&1)
                    if echo "$OUTPUT" | grep -q "validate action worked"; then
                        echo "${platform} sign success"
                    else
                        echo "${platform} sign failed"
                        echo "$OUTPUT"
                    fi
                    ;;
                win*)
                    echo "win sign"
                    TARGET_FILE="${TARGET_DIR}/${app_product_name}_${origin_identifier}_${web_app_version}.${origin_suffix}"
                    TARGET_FILE_SIGN="${TARGET_FILE}.signed"
                    echo "TARGET_FILE: $TARGET_FILE"
                    echo "WIN_SIGN_URL: $WIN_SIGN_URL"

                    curl -v -D - -F "file=@${TARGET_FILE}" ${WIN_SIGN_URL} -o ${TARGET_FILE_SIGN}

                    if [ -f "${TARGET_FILE_SIGN}" ]; then
                        # 获取文件大小
                        FILE_SIZE=$(stat -f%z "${TARGET_FILE_SIGN}" 2>/dev/null || stat -c%s "${TARGET_FILE_SIGN}" 2>/dev/null)
                        echo "FILE_SIZE: $FILE_SIZE"
                        if [ "$FILE_SIZE" -gt "$MIN_SIZE" ]; then
                            rm ${TARGET_FILE}
                            mv ${TARGET_FILE_SIGN} ${TARGET_FILE}
                            echo "sign ok"
                        else
                            rm ${TARGET_FILE_SIGN}
                            echo "sign error"
                        fi
                    else
                        echo "file not found"
                    fi
                    ;;
                linux*)
                    echo "Linux sign"
                    ;;
                *)
                    echo "unknown platform: $platform"
                    ;;
            esac
        fi

        end_time=$(date +%s)
        duration=$((end_time - start_time))
        echo "end $platform, duration: $duration seconds"
    done
done
