{{/*
Common helper templates used by the Mobile Money Helm chart.
*/}}
{{- define "proxypay.fullname" -}}
{{- printf "%s-%s" .Release.Name "proxypay" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "proxypay.name" -}}
{{- printf "%s" "proxypay" -}}
{{- end -}}

{{- define "proxypay.labels" -}}
app.kubernetes.io/name: {{ include "proxypay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- if .Values.labels }}
{{ toYaml .Values.labels | trim | indent 0 }}
{{- end -}}
{{- end -}}
