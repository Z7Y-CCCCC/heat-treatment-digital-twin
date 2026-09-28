// 全局应用弹窗(替代浏览器 alert/confirm):appDialog 状态 + Promise 化的 alert/confirm。
// 被 AdminPanel 各功能模块共享注入。

import { reactive } from 'vue'

export function useAppDialog() {
    const appDialog = reactive({
        visible: false,
        title: '提示',
        message: '',
        type: 'info',
        showCancel: false,
        confirmText: '确定',
        cancelText: '取消',
        secondaryText: '',
        details: [],
        verificationText: '',
        verificationInput: '',
        verificationLabel: ''
    })
    let appDialogResolve = null

    function openAppDialog(options = {}) {
        return new Promise(resolve => {
            appDialogResolve = resolve
            Object.assign(appDialog, {
                visible: true,
                title: options.title || (options.showCancel ? '请确认操作' : '系统提示'),
                message: String(options.message ?? ''),
                type: options.type || 'info',
                showCancel: !!options.showCancel,
                confirmText: options.confirmText || '确定',
                cancelText: options.cancelText || '取消',
                secondaryText: options.secondaryText || '',
                details: Array.isArray(options.details) ? options.details : [],
                verificationText: String(options.verificationText || ''),
                verificationInput: '',
                verificationLabel: String(options.verificationLabel || '')
            })
        })
    }

    function closeAppDialog(result) {
        if (
            result === true
            && appDialog.verificationText
            && appDialog.verificationInput !== appDialog.verificationText
        ) return
        appDialog.visible = false
        const resolve = appDialogResolve
        appDialogResolve = null
        if (resolve) resolve(result)
    }

    function alert(message, options = {}) {
        return openAppDialog({ ...options, message, showCancel: false })
    }

    function confirm(message, options = {}) {
        return openAppDialog({ ...options, message, showCancel: true, type: options.type || 'warning' })
    }

    return { appDialog, openAppDialog, closeAppDialog, alert, confirm }
}
